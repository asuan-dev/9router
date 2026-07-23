/**
 * POST /api/activities/checkin
 * Generic check-in API for all providers.
 *
 * Body: { connectionId, action }
 * Actions:
 *   "status"  — check if already checked in today
 *   "claim"   — manually claim check-in now
 *   "enable"  — enable auto check-in for this connection
 *   "disable" — disable auto check-in for this connection
 */

import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { getActivityProvider } from "open-sse/services/activities/registry.js";
import { manualCheckin, getCheckinStatus, configureAutoCheckin } from "@/shared/services/activityScheduler";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { connectionId, action } = body;

    if (!connectionId || !action) {
      return NextResponse.json(
        { ok: false, error: "missing_params", message: "connectionId and action required" },
        { status: 400 },
      );
    }

    const conn = await getProviderConnectionById(connectionId);
    if (!conn) {
      return NextResponse.json(
        { ok: false, error: "not_found", message: "connection not found" },
        { status: 404 },
      );
    }

    const provider = getActivityProvider(conn.provider);
    if (!provider?.checkin) {
      return NextResponse.json(
        { ok: false, error: "unsupported", message: `${conn.provider} has no check-in support` },
        { status: 400 },
      );
    }

    // Toggle auto check-in
    if (action === "enable" || action === "disable") {
      const enabled = action === "enable";
      const psd = conn.providerSpecificData || {};
      await updateProviderConnection(connectionId, {
        providerSpecificData: { ...psd, autoCheckinEnabled: enabled },
      });
      // Start/stop scheduler based on global state
      await configureAutoCheckin();
      return NextResponse.json({ ok: true, autoCheckinEnabled: enabled });
    }

    // Check status
    if (action === "status") {
      const result = await getCheckinStatus(connectionId);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }

    // Manual claim
    if (action === "claim") {
      const result = await manualCheckin(connectionId);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }

    return NextResponse.json(
      { ok: false, error: "unknown_action", message: `unknown action: ${action}` },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "server", message: e.message || String(e) },
      { status: 500 },
    );
  }
}
