import { describe, it, expect } from "vitest";
import {
  extractQoderworkProfileFromUserinfo,
  mapQoderworkCheckinStatus,
  mapQoderworkCheckinClaim,
  shanghaiDayKey,
} from "../../src/shared/utils/qoderworkProfile.js";

describe("qoderworkProfile", () => {
  it("extracts display name and login source; no phone when not phone-like", () => {
    const p = extractQoderworkProfileFromUserinfo({
      id: "u1",
      name: "aliyun7850973340",
      source: "sso.aliyun",
    });
    expect(p.displayName).toBe("aliyun7850973340");
    expect(p.phoneMasked).toBe(null);
    expect(p.loginSource).toBe("sso.aliyun");
  });

  it("masks phone-like name", () => {
    const p = extractQoderworkProfileFromUserinfo({ name: "13812345678" });
    expect(p.phoneMasked).toMatch(/\*/);
    expect(p.phone).toBe("13812345678");
  });

  it("maps CLAIMED_TODAY to already badge fields", () => {
    const day = shanghaiDayKey();
    const m = mapQoderworkCheckinStatus(
      { status: "CLAIMED_TODAY", rewardCredits: 100, currentStreakDays: 3 },
      day,
    );
    expect(m.autoCheckinLastResult).toBe("already");
    expect(m.autoCheckinDoneDay).toBe(day);
    expect(m.autoCheckinLastCredit).toBe(100);
  });

  it("maps claim success", () => {
    const day = shanghaiDayKey();
    const m = mapQoderworkCheckinClaim({ rewardCredits: 50 }, day);
    expect(m.autoCheckinLastResult).toBe("success");
    expect(m.autoCheckinDoneDay).toBe(day);
  });
});
