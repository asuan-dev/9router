// CodeBuddy CN daily auto check-in — simple, once per Shanghai day, staggered, no spam.
//
// Rules:
// 1) At most one successful day per connection (local autoCheckinDoneDay).
// 2) After Shanghai midnight, badge goes gray until today succeeds (doneDay !== today).
// 3) First attempt: shortly after 00:00, staggered per account (not all at once).
// 4) If PC starts late same day: still try once (missed window → run on next tick).
// 5) Fail → retry after 10 min, limited times; never claim every tick.
// 6) Upstream is source of truth: status.today_checked_in or claim code 10001 → done.
//
import "open-sse/index.js";

import {
  getSettings,
  getProviderConnections,
  getProviderConnectionById,
  updateProviderConnection,
} from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import {
  getCodebuddyCheckinStatus,
  claimCodebuddyDailyCheckin,
} from "open-sse/services/activities/codebuddy-cn.js";
import { extractCodebuddyProfileFromToken } from "@/shared/utils/codebuddyProfile";
import { CODEBUDDY_AUTO_CHECKIN_CONFIG as C } from "@/shared/constants/config";
import { EventEmitter } from "events";

const LOG = "CODEBUDDY_CHECKIN";

const g = (global.__codebuddyAutoCheckin ??= {
  interval: null,
  running: false,
  emitter: null,
});

if (!g.emitter) {
  g.emitter = new EventEmitter();
  g.emitter.setMaxListeners(50);
}

/** Process-local bus: check-in result after upstream API responds. */
export const checkinEmitter = g.emitter;

/** Asia/Shanghai calendar day YYYY-MM-DD */
export function shanghaiDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** China has no DST: Shanghai local wall-clock → UTC ms */
function shanghaiWallToUtcMs(year, month, day, hour, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

function parseDayKey(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return { year, month, day };
}

/**
 * Deterministic stagger in [0, spreadMs) so restarts don't re-shuffle the same day.
 * Spread default: first 3 hours after midnight (avoid bot-like pile-up at 00:00).
 */
function staggerMs(dayKey, connectionId, spreadMs) {
  let h = 2166136261;
  const seed = `${dayKey}\0${connectionId}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % Math.max(1, spreadMs);
}

/** First eligible attempt instant for this connection on Shanghai dayKey */
function firstAttemptUtcMs(dayKey, connectionId) {
  const { year, month, day } = parseDayKey(dayKey);
  const midnight = shanghaiWallToUtcMs(year, month, day, 0, 0, 0);
  return midnight + staggerMs(dayKey, connectionId, C.staggerMs);
}

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

function resolveUid(connection) {
  const fromPsd = connection.providerSpecificData?.uid;
  if (fromPsd) return String(fromPsd);
  if (!connection.accessToken) return null;
  return extractCodebuddyProfileFromToken(connection.accessToken).sub || null;
}

async function persistCheckinState(connectionId, patch, { notify = false } = {}) {
  const existing = await getProviderConnectionById(connectionId);
  if (!existing) return null;
  const providerSpecificData = {
    ...(existing.providerSpecificData || {}),
    ...patch,
  };
  await updateProviderConnection(connectionId, { providerSpecificData });
  if (notify) {
    checkinEmitter.emit("update", {
      connectionId,
      providerSpecificData: {
        autoCheckinDoneDay: providerSpecificData.autoCheckinDoneDay ?? null,
        autoCheckinLastResult: providerSpecificData.autoCheckinLastResult ?? null,
        autoCheckinLastMessage: providerSpecificData.autoCheckinLastMessage ?? null,
        autoCheckinLastAt: providerSpecificData.autoCheckinLastAt ?? null,
        autoCheckinLastCredit: providerSpecificData.autoCheckinLastCredit ?? null,
      },
    });
  }
  return providerSpecificData;
}

/**
 * Core per-connection logic (pure enough to test with deps).
 *
 * States written:
 * - autoCheckinDoneDay: Shanghai day when finished (success/already)
 * - autoCheckinNextAt: next allowed attempt ISO
 * - autoCheckinFailCount: consecutive fails today
 * - autoCheckinLastResult: success | already | fail | missing_uid
 * - autoCheckinLastMessage / LastAt
 */
async function runOneConnection(conn, deps, nowMs = Date.now()) {
  const dayKey = shanghaiDayKey(new Date(nowMs));
  const psd = conn.providerSpecificData || {};

  // Already finished today locally → never hit API again today
  if (psd.autoCheckinDoneDay === dayKey) return;

  const firstAt = firstAttemptUtcMs(dayKey, conn.id);
  let nextAt = psd.autoCheckinNextAt ? new Date(psd.autoCheckinNextAt).getTime() : null;
  let fails = Number(psd.autoCheckinFailCount) || 0;

  // New Shanghai day (or missing plan): schedule staggered first try; do not claim in the same step
  // unless the slot is already due (late boot / past firstAt).
  if (!Number.isFinite(nextAt) || psd.autoCheckinPlanDay !== dayKey) {
    nextAt = nowMs < firstAt ? firstAt : nowMs;
    fails = 0;
    await deps.persistCheckinState(conn.id, {
      autoCheckinPlanDay: dayKey,
      autoCheckinNextAt: new Date(nextAt).toISOString(),
      autoCheckinFailCount: 0,
    });
  }

  if (nowMs < nextAt) return;

  // Cap retries so we don't look like a bot hammering the API
  if (fails >= C.maxFailsPerDay) {
    return;
  }

  let connection = conn;
  const proxyCfg = await deps.resolveConnectionProxyConfig(connection);
  const proxyOptions = buildProxyOptions(proxyCfg);

  try {
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    if (r?.connection) connection = r.connection;
  } catch (e) {
    console.warn(`[${LOG}] refresh ${conn.id}: ${e.message}`);
  }

  const uid = resolveUid(connection);
  if (!uid) {
    console.warn(`[${LOG}] missing_uid ${conn.id}`);
    await deps.persistCheckinState(conn.id, {
      autoCheckinLastResult: "missing_uid",
      autoCheckinLastMessage: "missing uid",
      autoCheckinLastAt: new Date(nowMs).toISOString(),
      autoCheckinNextAt: new Date(nowMs + C.retryMs).toISOString(),
      autoCheckinPlanDay: dayKey,
      autoCheckinFailCount: fails + 1,
    }, { notify: true });
    return;
  }

  const token = connection.accessToken;

  // 1) Ask upstream — source of truth (covers check-in outside 9R)
  const status = await deps.getCodebuddyCheckinStatus(token, { uid }, proxyOptions);
  if (status.ok && status.data?.today_checked_in === true) {
    console.log(`[${LOG}] already ${conn.id} day=${dayKey}`);
    await deps.persistCheckinState(conn.id, {
      autoCheckinDoneDay: dayKey,
      autoCheckinLastResult: "already",
      autoCheckinLastMessage: status.data?.theme_name || "today_checked_in",
      autoCheckinLastAt: new Date(nowMs).toISOString(),
      autoCheckinFailCount: 0,
    }, { notify: true });
    return;
  }

  // 2) Claim once
  const claim = await deps.claimCodebuddyDailyCheckin(token, { uid }, proxyOptions);
  if (claim.ok) {
    const result = claim.already ? "already" : "success";
    console.log(
      `[${LOG}] ${result} ${conn.id} day=${dayKey}` +
        (claim.credit != null ? ` credit=${claim.credit}` : ""),
    );
    await deps.persistCheckinState(conn.id, {
      autoCheckinDoneDay: dayKey,
      autoCheckinLastResult: result,
      autoCheckinLastMessage:
        claim.message || (claim.already ? "already" : `credit ${claim.credit ?? "?"}`),
      autoCheckinLastAt: new Date(nowMs).toISOString(),
      autoCheckinLastCredit: claim.credit ?? null,
      autoCheckinFailCount: 0,
    }, { notify: true });
    return;
  }

  // 3) Fail → schedule sparse retry
  console.warn(`[${LOG}] fail ${conn.id}: ${claim.message || claim.error}`);
  await deps.persistCheckinState(conn.id, {
    autoCheckinLastResult: "fail",
    autoCheckinLastMessage: claim.message || claim.error || "fail",
    autoCheckinLastAt: new Date(nowMs).toISOString(),
    autoCheckinNextAt: new Date(nowMs + C.retryMs).toISOString(),
    autoCheckinPlanDay: dayKey,
    autoCheckinFailCount: fails + 1,
  }, { notify: true });
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    persistCheckinState,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    getCodebuddyCheckinStatus,
    claimCodebuddyDailyCheckin,
  };
}

export async function runCodebuddyAutoCheckinTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const settings = await deps.getSettings();
    if (!hasCodebuddyAutoCheckinEnabled(settings)) return;

    // Global boolean: when on, every active CodeBuddy CN OAuth is a target.
    const conns = await deps.getProviderConnections({
      provider: "codebuddy-cn",
      isActive: true,
    });
    const targets = conns.filter((c) => c.authType === "oauth");

    // Small sequential delay between accounts on same tick → further anti pile-up
    for (let i = 0; i < targets.length; i++) {
      const conn = targets[i];
      try {
        await runOneConnection(conn, deps);
      } catch (e) {
        console.warn(`[${LOG}] ${conn.id}: ${e.message}`);
      }
      if (i < targets.length - 1 && C.betweenAccountsMs > 0) {
        await new Promise((r) => setTimeout(r, C.betweenAccountsMs));
      }
    }
  } catch (e) {
    console.warn(`[${LOG}] tick error:`, e.message);
  } finally {
    state.running = false;
  }
}



export function startCodebuddyAutoCheckin() {
  if (g.interval) return;
  console.log(`[${LOG}] scheduler started`);
  runCodebuddyAutoCheckinTick().catch(() => {});
  g.interval = setInterval(() => {
    runCodebuddyAutoCheckinTick().catch(() => {});
  }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopCodebuddyAutoCheckin() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log(`[${LOG}] scheduler stopped`);
}

export function configureCodebuddyAutoCheckin(settings) {
  if (hasCodebuddyAutoCheckinEnabled(settings)) {
    startCodebuddyAutoCheckin();
  } else {
    stopCodebuddyAutoCheckin();
  }
}

/**
 * Global switch only: settings.codebuddyAutoCheckin.enabled
 * Legacy: old per-id map { connections: { id: true } } still counts as ON.
 */
export function hasCodebuddyAutoCheckinEnabled(settings) {
  const cfg = settings?.[C.settingsKey];
  if (!cfg || typeof cfg !== "object") return false;
  if (typeof cfg.enabled === "boolean") return cfg.enabled === true;
  // migrate-read: previous per-connection map
  return Object.values(cfg.connections || {}).some(Boolean);
}

export const __test = {
  shanghaiDayKey,
  firstAttemptUtcMs,
  staggerMs,
  runOneConnection,
};
