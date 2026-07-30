// Daily hot snapshot via `VACUUM INTO` — SQLite's officially-safe way to copy a
// live database (https://www.sqlite.org/lang_vacuum.html#vacuuminto, and
// howtocorrupt.html §1.2 lists it as a corruption-safe backup method).
//
// Why this exists: the DB file has corrupted more than once on virtualized
// bind-mount storage. VACUUM INTO produces a consistent, defragmented copy even
// while the DB is live, so a fresh malformed page never propagates into the
// snapshot. Recovery is manual: copy the newest good snapshot back over
// data.sqlite. Snapshots older than 7 days are auto-deleted (newest always kept).
import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./paths.js";
import { timestampSlug } from "./version.js";

const SNAPSHOTS_DIR = path.join(DB_DIR, "snapshots");
// Auto-delete snapshots older than 7 days (age-based, not count-based, so
// multiple restarts in one day never evict a still-recent snapshot). The single
// newest snapshot is always kept as a floor, even if it is older than the window.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function pruneOldSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return;
  const entries = fs
    .readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".sqlite"))
    .map((e) => {
      const full = path.join(SNAPSHOTS_DIR, e.name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - MAX_AGE_MS;
  // Keep entries[0] (newest) unconditionally; delete the rest once past cutoff.
  for (const snap of entries.slice(1)) {
    if (snap.mtime < cutoff) {
      try { fs.rmSync(snap.full, { force: true }); } catch {}
    }
  }
}

// Write one consistent snapshot. Best-effort: never throws into callers.
export function takeSnapshot(adapter) {
  try {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    const dest = path.join(SNAPSHOTS_DIR, `data-${timestampSlug()}.sqlite`);
    const escaped = dest.replace(/'/g, "''");
    adapter.exec(`VACUUM INTO '${escaped}'`);
    pruneOldSnapshots();
    return dest;
  } catch (e) {
    console.warn(`[DB][snapshot] failed: ${e.message}`);
    return null;
  }
}

// Schedule a daily snapshot. Runs one shortly after boot (10s) so a fresh
// install/restart always has at least one, then every 24h. Timer is unref'd so
// it never keeps the process alive.
export function startSnapshotSchedule(adapter) {
  const kick = () => takeSnapshot(adapter);
  const boot = setTimeout(kick, 10_000);
  if (typeof boot.unref === "function") boot.unref();
  const timer = setInterval(kick, SNAPSHOT_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => { clearTimeout(boot); clearInterval(timer); };
}
