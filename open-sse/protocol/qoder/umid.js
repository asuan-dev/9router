/**
 * Qoder UMID via the official `runtime-info` binary (no algorithm reverse).
 *
 * Spawns the same helper qodercli extracts under `~/.qoder/.bin/`:
 *   runtime-info-<platform>-<arch>-<hash>
 * and parses stdout JSON:
 *   { machineToken, machineType, machineCode, vmInfo }
 *
 * Region `0` is enough for a local token. Result is cached for the process.
 * On platforms without a binary (e.g. Linux Docker) this returns null and
 * callers keep using the connection's machineId UUID.
 *
 * Env overrides:
 *   QODER_RUNTIME_INFO / UMID_RUNTIME_INFO — absolute path to the binary
 *   QODER_UMID_DISABLED=1|true|yes|on — skip entirely (match CLI)
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Region ONLINE — instant local token (1/2 may hang). */
export const UMID_REGION_ONLINE = 0;

/** Spawn budget; binary normally returns in well under 1s. */
export const UMID_TIMEOUT_MS = 8_000;

/**
 * @typedef {object} UmidInfo
 * @property {string} machineToken
 * @property {string} [machineType]
 * @property {string} [machineCode]
 * @property {{ isVm?: boolean, brand?: string, percentage?: number, vmTypeCode?: number }} [vmInfo]
 * @property {string} [binaryPath]
 */

/** @type {UmidInfo | null | undefined} undefined = not tried */
let cache;
/** @type {Promise<UmidInfo | null> | null} */
let inflight = null;
/** @type {Map<string, UmidInfo | null>} per-UUID fake UMID cache */
const uuidCache = new Map();
/** @type {Map<string, Promise<UmidInfo | null>>} per-UUID inflight */
const uuidInflight = new Map();

function isUmidDisabled() {
  const v = process.env.QODER_UMID_DISABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the official runtime-info binary.
 * @returns {string | null}
 */
export function resolveRuntimeInfoBinary() {
  const envPath =
    process.env.QODER_RUNTIME_INFO?.trim() ||
    process.env.UMID_RUNTIME_INFO?.trim();
  if (envPath && isExecutable(envPath)) return envPath;

  const platform = process.platform; // darwin | linux | win32
  const arch = process.arch; // arm64 | x64
  const prefix = `runtime-info-${platform}-${arch}-`;
  const binDir = path.join(os.homedir(), ".qoder", ".bin");

  try {
    const names = fs.readdirSync(binDir).filter((n) => n.startsWith(prefix));
    // Prefer lexicographically last (newer hash suffix if multiple)
    names.sort();
    for (let i = names.length - 1; i >= 0; i--) {
      const full = path.join(binDir, names[i]);
      if (isExecutable(full)) return full;
    }
  } catch {
    // no dir
  }

  // Dev re-signed copy used during RE work
  const resigned = "/tmp/runtime-info-resigned";
  if (isExecutable(resigned)) return resigned;

  return null;
}

/**
 * Locate the GOT-inject dylib (umid_inject.dylib) next to the binary.
 * Patches the main binary's __DATA GOT entry for IORegistryEntryCreateCFProperty
 * so a fake IOPlatformUUID can be fed without touching the algorithm.
 * @param {string} [binaryPath]
 * @returns {string | null}
 */
function resolveInjectDylib(binaryPath) {
  const dylibEnv =
    process.env.UMID_INJECT_DYLIB?.trim() ||
    process.env.QODER_UMID_INJECT_DYLIB?.trim();
  if (dylibEnv && fs.existsSync(dylibEnv)) return dylibEnv;

  // Look next to the binary, then in the default .qoder/.bin dir
  const searchDirs = [];
  if (binaryPath) searchDirs.push(path.dirname(binaryPath));
  searchDirs.push(path.join(os.homedir(), ".qoder", ".bin"));
  for (const dir of searchDirs) {
    const candidate = path.join(dir, "umid_inject.dylib");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * One-shot spawn + JSON parse.
 * @param {object} [opts]
 * @param {string} [opts.binaryPath]
 * @param {number} [opts.region]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.machineUuid]  feed a fake IOPlatformUUID (GOT-inject dylib)
 * @param {typeof spawn} [opts.spawnImpl]  test seam
 * @returns {Promise<UmidInfo | null>}
 */
export function fetchUmidInfo(opts = {}) {
  if (isUmidDisabled()) return Promise.resolve(null);

  let binaryPath = opts.binaryPath || resolveRuntimeInfoBinary();
  // When injecting a fake UUID, the binary must accept DYLD_INSERT_LIBRARIES.
  // The original Qoder binary is hardened and ignores the env var silently;
  // prefer an inject-capable copy (env override or /tmp/runtime-info-resigned).
  if (opts.machineUuid && !opts.binaryPath) {
    const injectBin =
      process.env.UMID_INJECT_BINARY?.trim() ||
      process.env.QODER_UMID_INJECT_BINARY?.trim();
    if (injectBin && isExecutable(injectBin)) {
      binaryPath = injectBin;
    } else if (isExecutable("/tmp/runtime-info-resigned")) {
      binaryPath = "/tmp/runtime-info-resigned";
    }
  }
  if (!binaryPath) return Promise.resolve(null);

  const region = opts.region ?? UMID_REGION_ONLINE;
  const timeoutMs = opts.timeoutMs ?? UMID_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl || spawn;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      // When a fake UUID is requested, inject via GOT-patch dylib.
      // The dylib patches the binary's __DATA GOT so IORegistryEntryCreateCFProperty
      // returns our fake IOPlatformUUID — middle algorithm untouched.
      const spawnOpts = {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      };
      if (opts.machineUuid) {
        const dylib = resolveInjectDylib(binaryPath);
        if (dylib) {
          spawnOpts.env = {
            ...process.env,
            DYLD_INSERT_LIBRARIES: dylib,
            UMID_FAKE_UUID: opts.machineUuid,
          };
        }
      }
      child = spawnImpl(binaryPath, [String(region)], spawnOpts);
    } catch {
      finish(null);
      return;
    }

    let stdout = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    // drain stderr so the child never blocks on a full pipe
    child.stderr?.resume?.();

    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        const raw = String(stdout).trim();
        const line = raw.split("\n").filter(Boolean).pop() || raw;
        const parsed = JSON.parse(line);
        if (!parsed?.machineToken || typeof parsed.machineToken !== "string") {
          finish(null);
          return;
        }
        finish({
          machineToken: parsed.machineToken,
          machineType: parsed.machineType,
          machineCode: parsed.machineCode,
          vmInfo: parsed.vmInfo,
          binaryPath,
        });
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Process-lifetime cache. Concurrent callers share one spawn.
 * @param {object} [opts]  `{ force: true }` to re-run; other keys → fetchUmidInfo
 * @returns {Promise<UmidInfo | null>}
 */
export async function getUmidInfo(opts = {}) {
  if (opts.force) {
    cache = undefined;
    inflight = null;
  }
  if (cache !== undefined) return cache;
  if (inflight) return inflight;

  const { force: _force, ...fetchOpts } = opts;
  inflight = fetchUmidInfo(fetchOpts)
    .then((info) => {
      cache = info;
      inflight = null;
      return info;
    })
    .catch(() => {
      cache = null;
      inflight = null;
      return null;
    });
  return inflight;
}


/**
 * Cached fetch of a UMID for a specific (fake) machine UUID.
 * Feeds the UUID into the official binary via GOT-patch dylib —
 * the SecurityGuard algorithm runs unchanged; only the IOKit input differs.
 * Each unique UUID produces a unique, deterministic UMID.
 * @param {string} uuid  the fake IOPlatformUUID
 * @param {object} [opts]  `{ force: true }` to re-run
 * @returns {Promise<UmidInfo | null>}
 */
export async function getUmidForUuid(uuid, opts = {}) {
  if (!uuid) return getUmidInfo(opts);
  if (opts.force) {
    uuidCache.delete(uuid);
    uuidInflight.delete(uuid);
  }
  if (uuidCache.has(uuid)) return uuidCache.get(uuid);
  if (uuidInflight.has(uuid)) return uuidInflight.get(uuid);

  const { force: _force, ...fetchOpts } = opts;
  const p = fetchUmidInfo({ ...fetchOpts, machineUuid: uuid })
    .then((info) => {
      uuidCache.set(uuid, info);
      uuidInflight.delete(uuid);
      return info;
    })
    .catch(() => {
      uuidCache.set(uuid, null);
      uuidInflight.delete(uuid);
      return null;
    });
  uuidInflight.set(uuid, p);
  return p;
}

/**
 * Sync peek — no spawn. Empty string if not loaded yet / unavailable.
 * @returns {string}
 */
export function getCachedMachineToken() {
  return (cache && cache.machineToken) || "";
}


/** @internal */
export function _resetUmidCacheForTest() {
  cache = undefined;
  inflight = null;
  uuidCache.clear();
  uuidInflight.clear();
}
