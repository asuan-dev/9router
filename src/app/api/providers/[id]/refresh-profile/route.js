import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/models";
import { extractCodebuddyProfileFromToken } from "@/shared/utils/codebuddyProfile";

export const dynamic = "force-dynamic";

/**
 * POST /api/providers/[id]/refresh-profile
 * Manual profile refresh for CodeBuddy CN OAuth connections:
 * - name ← JWT nickname (when present)
 * - providerSpecificData.phoneMasked ← masked preferred_username phone
 * Does not change OAuth tokens. Local UX only.
 */
export async function POST(_request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (existing.provider !== "codebuddy-cn") {
      return NextResponse.json(
        { error: "Profile refresh is only supported for CodeBuddy CN" },
        { status: 400 },
      );
    }

    if (existing.authType !== "oauth") {
      return NextResponse.json(
        { error: "Profile refresh requires an OAuth connection" },
        { status: 400 },
      );
    }

    const accessToken = existing.accessToken;
    if (!accessToken || typeof accessToken !== "string") {
      return NextResponse.json(
        { error: "No access token available for this connection" },
        { status: 400 },
      );
    }

    const profile = extractCodebuddyProfileFromToken(accessToken);
    if (!profile.nickname && !profile.phoneMasked) {
      return NextResponse.json(
        { error: "Could not parse nickname or phone from credential" },
        { status: 422 },
      );
    }

    const updateData = {
      providerSpecificData: {
        ...(existing.providerSpecificData || {}),
        profileRefreshedAt: new Date().toISOString(),
      },
    };

    if (profile.nickname) {
      updateData.name = profile.nickname;
    }
    if (profile.phoneMasked) {
      // Store masked form for list UI; keep full phone only in DB-side field if present
      updateData.providerSpecificData.phoneMasked = profile.phoneMasked;
      if (profile.phone) {
        updateData.providerSpecificData.phone = profile.phone;
      }
    }
    if (profile.sub) {
      updateData.providerSpecificData.uid = profile.sub;
    }

    const updated = await updateProviderConnection(id, {
      ...updateData,
      // merge providerSpecificData carefully: updateProviderConnection shallow-merges top-level
      // so pass merged PSD as a whole (connectionsRepo merges { ...existing, ...data })
      providerSpecificData: {
        ...(existing.providerSpecificData || {}),
        ...updateData.providerSpecificData,
      },
      ...(updateData.name ? { name: updateData.name } : {}),
    });

    if (!updated) {
      return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
    }

    const result = { ...updated };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;
    // Never return full phone to the client
    if (result.providerSpecificData?.phone) {
      const { phone, ...restPsd } = result.providerSpecificData;
      result.providerSpecificData = restPsd;
    }

    return NextResponse.json({
      connection: result,
      refreshed: {
        name: Boolean(profile.nickname),
        phoneMasked: Boolean(profile.phoneMasked),
      },
    });
  } catch (error) {
    console.log("Error refreshing connection profile:", error);
    return NextResponse.json({ error: "Failed to refresh profile" }, { status: 500 });
  }
}
