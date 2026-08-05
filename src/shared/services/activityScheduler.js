/**
 * Generic auto check-in scheduler.
 *
 * Replaces codebuddyAutoCheckin.js with a provider-agnostic scheduler.
 * Any provider registered in open-sse/services/activities/registry.js
 * that exposes a `checkin` interface gets automatic daily check-in.
 *
 * Per-connection opt-in: providerSpecificData.autoCheckinEnabled === true
 * State keys (backward-compatible with CodeBuddy badge UI):
 *   autoCheckinDoneDay, autoCheckinPlanDay, autoCheckinNextAt,
 *   autoCheckinFailCount, autoCheckinLastResult, autoCheckinLastMessage,
 *   autoCheckinLastAt, autoCheckinLastCredit
 */

import "open-sse/index.js";

import { getProviderConnections, getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { getActivityProvider, getCheckinProviderIds } from "open-sse/services/activities/registry.js";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { EventEmitter } from "events";
import { dayKeyInTimeZone } from "@/shared/utils/timezone";
import { dbg } from "open-sse/utils/debugLog.js";

const LOG = "AUTO_CHECKIN";

// --- Config ---
const CONFIG = {
  tickIntervalMs: 60 * 1000,
  staggerMs: 3 * 60 * 60 * 1000,   // spread first try across 0–3h after midnight
  retryMs: 10 * 60 * 1000,          // after fail, wait 10 min
  maxFailsPerDay: 6,
  betweenAccountsMs: 2000,
};

// --- Global state (survives HMR) ---
const g = (global.__activityAutoCheckin ??= {
  interval: null,
  running: false,
  emitter: null,
});
if (!g.emitter) {
  g.emitter = new EventEmitter();
  g.emitter.setMaxListeners(50);
}

/** Event bus: emits "checkin" with { connectionId, provider, result } after each attempt. */
export const checkinEmitter = g.emitter;


/** Get UTC offset minutes for a timezone at a given date. */
function tzOffsetMs(timezone, date = new Date()) {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: timezone });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

/** Midnight of dayKey in the provider's timezone → UTC ms. */
function midnightUtcMs(dayKey, timezone) {
  const [y, m, d] = dayKey.split("-").map(Number);
  // Approximate: use noon to avoid DST edge, then subtract 12h
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offset = tzOffsetMs(timezone, noon);
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offset;
}

/** Deterministic stagger so restarts don't re-shuffle. */
function staggerMs(dayKey, connectionId) {
  let hash = 0;
  const s = `${dayKey}:${connectionId}`;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % CONFIG.staggerMs;
}

/** First eligible attempt instant for this connection. */
function firstAttemptUtcMs(dayKey, connectionId, timezone) {
  return midnightUtcMs(dayKey, timezone) + staggerMs(dayKey, connectionId);
}

// --- Persistence ---

async function persistState(connectionId, patch, notify = false, provider = null) {
  const existing = await getProviderConnectionById(connectionId);
  if (!existing) return;
  const merged = { ...(existing.providerSpecificData || {}), ...patch };
  await updateProviderConnection(connectionId, { providerSpecificData: merged });
  if (notify) {
    checkinEmitter.emit("checkin", { connectionId, provider, result: patch });
  }
}

// --- Core per-connection logic ---

async function runOneConnection(conn, provider, nowMs = Date.now()) {
  const timezone = provider.timezone || "Asia/Shanghai";
  const dayKey = dayKeyInTimeZone(timezone, new Date(nowMs));
  const psd = conn.providerSpecificData || {};

  // Already done today → skip
  if (psd.autoCheckinDoneDay === dayKey) return;

  const firstAt = firstAttemptUtcMs(dayKey, conn.id, timezone);
  let nextAt = psd.autoCheckinNextAt ? new Date(psd.autoCheckinNextAt).getTime() : null;
  let fails = Number(psd.autoCheckinFailCount) || 0;

  // New day or missing plan → schedule staggered first try
  if (!Number.isFinite(nextAt) || psd.autoCheckinPlanDay !== dayKey) {
    nextAt = nowMs < firstAt ? firstAt : nowMs;
    fails = 0;
    await persistState(conn.id, {
      autoCheckinPlanDay: dayKey,
      autoCheckinNextAt: new Date(nextAt).toISOString(),
      autoCheckinFailCount: 0,
    });
  }

  if (nowMs < nextAt) return;
  if (fails >= CONFIG.maxFailsPerDay) return;

  // Refresh token if needed
  let connection = conn;
  try {
    const r = await refreshAndUpdateCredentials(connection, false, null);
    if (r?.connection) connection = r.connection;
  } catch {
    console.warn(`[${LOG}] credential refresh failed for connection ${conn.id}`);
  }

  // Resolve auth
  const auth = provider.checkin.resolveAuth(connection);
  if (!auth) {
    await persistState(conn.id, {
      autoCheckinLastResult: "missing_auth",
      autoCheckinLastMessage: "missing token/credentials",
      autoCheckinLastAt: new Date(nowMs).toISOString(),
      autoCheckinNextAt: new Date(nowMs + CONFIG.retryMs).toISOString(),
      autoCheckinPlanDay: dayKey,
      autoCheckinFailCount: fails + 1,
    }, true, provider.providerId);
    return;
  }

  // 1) Check status (source of truth)
  const status = await provider.checkin.checkStatus(connection, null);
  if (status.ok && status.done) {
    await persistState(conn.id, {
      autoCheckinDoneDay: dayKey,
      autoCheckinLastResult: "already",
      autoCheckinLastMessage: status.message || "已签到",
      autoCheckinLastAt: new Date(nowMs).toISOString(),
      autoCheckinLastCredit: status.credits ?? null,
      autoCheckinFailCount: 0,
    }, true, provider.providerId);
    return;
  }

  // 2) Claim
  const claim = await provider.checkin.claim(connection, null);
  if (claim.ok) {
    const result = claim.already ? "already" : "success";
    await persistState(conn.id, {
      autoCheckinDoneDay: dayKey,
      autoCheckinLastResult: result,
      autoCheckinLastMessage: claim.message || (claim.already ? "已签到" : "签到成功"),
      autoCheckinLastAt: new Date(nowMs).toISOString(),
      autoCheckinLastCredit: claim.credits ?? null,
      autoCheckinFailCount: 0,
    }, true, provider.providerId);
    return;
  }

  // 3) Fail → retry later
  await persistState(conn.id, {
    autoCheckinLastResult: "fail",
    autoCheckinLastMessage: claim.message || "签到失败",
    autoCheckinLastAt: new Date(nowMs).toISOString(),
    autoCheckinNextAt: new Date(nowMs + CONFIG.retryMs).toISOString(),
    autoCheckinPlanDay: dayKey,
    autoCheckinFailCount: fails + 1,
  }, true, provider.providerId);
}

// --- Tick: scan all providers ---

export async function runAutoCheckinTick() {
  if (g.running) return;
  g.running = true;
  try {
    const providerIds = getCheckinProviderIds();
    for (const providerId of providerIds) {
      const provider = getActivityProvider(providerId);
      if (!provider?.checkin) continue;

      const conns = await getProviderConnections({ provider: providerId, isActive: true });
      const targets = conns.filter(
        (c) => c.authType === "oauth" && c.providerSpecificData?.autoCheckinEnabled === true,
      );

      for (let i = 0; i < targets.length; i++) {
        try {
          await runOneConnection(targets[i], provider);
        } catch {
          console.warn(`[${LOG}] check-in failed for ${providerId}/${targets[i].id}`);
        }
        if (i < targets.length - 1 && CONFIG.betweenAccountsMs > 0) {
          await new Promise((r) => setTimeout(r, CONFIG.betweenAccountsMs));
        }
      }
    }
  } catch {
    console.warn(`[${LOG}] scheduler tick failed`);
  } finally {
    g.running = false;
  }
}

// --- Lifecycle ---

export function startAutoCheckin() {
  if (g.interval) return;
  dbg(LOG, `scheduler started (providers: ${getCheckinProviderIds().join(", ")})`);
  runAutoCheckinTick().catch(() => {});
  g.interval = setInterval(() => {
    runAutoCheckinTick().catch(() => {});
  }, CONFIG.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopAutoCheckin() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  dbg(LOG, "scheduler stopped");
}

/** Check if any connection has autoCheckin enabled (used at app startup). */
export async function hasAnyAutoCheckinEnabled() {
  const providerIds = getCheckinProviderIds();
  for (const providerId of providerIds) {
    const conns = await getProviderConnections({ provider: providerId, isActive: true });
    if (conns.some((c) => c.providerSpecificData?.autoCheckinEnabled === true)) {
      return true;
    }
  }
  return false;
}

/** Configure from settings change (called by settings API route). */
export async function configureAutoCheckin() {
  if (await hasAnyAutoCheckinEnabled()) {
    startAutoCheckin();
  } else {
    stopAutoCheckin();
  }
}

// --- Manual trigger (for UI "签到" button) ---

/** Manually run check-in for one connection right now. */
export async function manualCheckin(connectionId) {
  const conn = await getProviderConnectionById(connectionId);
  if (!conn) return { ok: false, message: "connection not found" };
  const provider = getActivityProvider(conn.provider);
  if (!provider?.checkin) return { ok: false, message: "provider has no check-in" };

  const result = await provider.checkin.claim(conn, null);
  if (result.ok) {
    const timezone = provider.timezone || "Asia/Shanghai";
    const dayKey = dayKeyInTimeZone(timezone);
    await persistState(connectionId, {
      autoCheckinDoneDay: dayKey,
      autoCheckinLastResult: result.already ? "already" : "success",
      autoCheckinLastMessage: result.message,
      autoCheckinLastAt: new Date().toISOString(),
      autoCheckinLastCredit: result.credits ?? null,
      autoCheckinFailCount: 0,
    }, true, provider.providerId);
  }
  return result;
}

/** Get check-in status for one connection. */
export async function getCheckinStatus(connectionId) {
  const conn = await getProviderConnectionById(connectionId);
  if (!conn) return { ok: false, message: "connection not found" };
  const provider = getActivityProvider(conn.provider);
  if (!provider?.checkin) return { ok: false, message: "provider has no check-in" };
  return provider.checkin.checkStatus(conn, null);
}
