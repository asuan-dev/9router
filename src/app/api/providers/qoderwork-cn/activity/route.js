/**
 * POST /api/providers/qoderwork-cn/activity
 * Body: { connectionId, action }
 * Actions: checkin-status | checkin-claim | pro-eligibility | pro-claim |
 *          invitation-code | invitation-rewards
 *
 * checkin-status / checkin-claim also write ConnectionRow badge fields into
 * providerSpecificData (same keys as codebuddy-cn).
 */

import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { runQoderworkActivity } from "open-sse/services/activities/qoderwork-cn.js";
import {
  mapQoderworkCheckinClaim,
  mapQoderworkCheckinStatus,
  shanghaiDayKey,
} from "@/shared/utils/qoderworkProfile";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const connectionId = body.connectionId;
    const action = body.action;
    if (!connectionId || !action) {
      return NextResponse.json(
        { ok: false, error: "missing_params", message: "connectionId and action required" },
        { status: 400 },
      );
    }

    const conn = await getProviderConnectionById(connectionId);
    if (!conn || conn.provider !== "qoderwork-cn") {
      return NextResponse.json(
        { ok: false, error: "not_found", message: "qoderwork-cn connection not found" },
        { status: 404 },
      );
    }

    const accessToken = conn.accessToken || conn.token;
    if (!accessToken) {
      return NextResponse.json(
        { ok: false, error: "missing_token", message: "connection has no access token" },
        { status: 401 },
      );
    }

    const result = await runQoderworkActivity(action, accessToken, null);
    const dayKey = shanghaiDayKey();
    const payload = result?.data || result?.body || null;

    if (result?.ok && (action === "checkin-status" || action === "checkin-claim") && payload) {
      const fields =
        action === "checkin-claim"
          ? mapQoderworkCheckinClaim(payload, dayKey)
          : mapQoderworkCheckinStatus(payload, dayKey);
      await updateProviderConnection(connectionId, {
        providerSpecificData: {
          ...(conn.providerSpecificData || {}),
          ...fields,
        },
      });
      result.badge = fields;
    }

    const status = result.ok ? 200 : result.error === "auth" ? 401 : 502;
    return NextResponse.json(result, { status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "server", message: e.message || String(e) },
      { status: 500 },
    );
  }
}
