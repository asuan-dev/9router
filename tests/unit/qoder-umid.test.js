import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fetchUmidInfo,
  getUmidInfo,
  getCachedMachineToken,
  resolveRuntimeInfoBinary,
  _resetUmidCacheForTest,
  UMID_REGION_ONLINE,
} from "../../open-sse/protocol/qoder/umid.js";

function fakeChild(stdout, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stderr.resume = () => {};
  child.kill = vi.fn();
  // emit after listeners attach
  queueMicrotask(() => {
    if (stdout != null) child.stdout.emit("data", stdout);
    child.emit("close", code);
  });
  return child;
}

describe("qoder umid wrapper", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    _resetUmidCacheForTest();
    delete process.env.QODER_RUNTIME_INFO;
    delete process.env.UMID_RUNTIME_INFO;
    delete process.env.QODER_UMID_DISABLED;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
    _resetUmidCacheForTest();
  });

  it("fetchUmidInfo returns null when disabled", async () => {
    process.env.QODER_UMID_DISABLED = "1";
    const r = await fetchUmidInfo({ binaryPath: "/nope" });
    expect(r).toBeNull();
  });

  it("fetchUmidInfo parses official-shape JSON from spawn", async () => {
    const payload = {
      machineToken: "P1gA-test-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      machineType: "a02eee4291ccf8769e",
      machineCode: "e668e2e200a759d9c1",
      vmInfo: { isVm: false, brand: "None", percentage: 0, vmTypeCode: 91 },
    };
    const spawnImpl = vi.fn(() => fakeChild(JSON.stringify(payload) + "\n", 0));
    const r = await fetchUmidInfo({
      binaryPath: "/fake/runtime-info",
      spawnImpl,
      region: UMID_REGION_ONLINE,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "/fake/runtime-info",
      ["0"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(r).toEqual({
      machineToken: payload.machineToken,
      machineType: payload.machineType,
      machineCode: payload.machineCode,
      vmInfo: payload.vmInfo,
      binaryPath: "/fake/runtime-info",
    });
  });

  it("fetchUmidInfo returns null on non-zero exit", async () => {
    const spawnImpl = vi.fn(() => fakeChild("{}", 1));
    const r = await fetchUmidInfo({ binaryPath: "/fake/runtime-info", spawnImpl });
    expect(r).toBeNull();
  });

  it("fetchUmidInfo returns null on empty machineToken", async () => {
    const spawnImpl = vi.fn(() => fakeChild(JSON.stringify({ machineToken: "" }), 0));
    const r = await fetchUmidInfo({ binaryPath: "/fake/runtime-info", spawnImpl });
    expect(r).toBeNull();
  });

  it("getUmidInfo caches and de-dupes concurrent calls", async () => {
    let spawns = 0;
    const payload = {
      machineToken: "tok-cached",
      machineType: "t",
      machineCode: "c",
      vmInfo: { isVm: false },
    };
    const spawnImpl = vi.fn(() => {
      spawns += 1;
      return fakeChild(JSON.stringify(payload), 0);
    });
    const [a, b] = await Promise.all([
      getUmidInfo({ binaryPath: "/fake/ri", spawnImpl }),
      getUmidInfo({ binaryPath: "/fake/ri", spawnImpl }),
    ]);
    expect(a.machineToken).toBe("tok-cached");
    expect(b.machineToken).toBe("tok-cached");
    expect(spawns).toBe(1);
    expect(getCachedMachineToken()).toBe("tok-cached");

    // second wave hits cache — no new spawn
    const c = await getUmidInfo({ binaryPath: "/fake/ri", spawnImpl });
    expect(c.machineToken).toBe("tok-cached");
    expect(spawns).toBe(1);
  });

  it("resolveRuntimeInfoBinary honors QODER_RUNTIME_INFO when executable", () => {
    // Use a known executable on this host (node itself)
    const nodeBin = process.execPath;
    process.env.QODER_RUNTIME_INFO = nodeBin;
    expect(resolveRuntimeInfoBinary()).toBe(nodeBin);
  });

  it("resolveRuntimeInfoBinary finds ~/.qoder/.bin when present", () => {
    const binDir = path.join(os.homedir(), ".qoder", ".bin");
    if (!fs.existsSync(binDir)) return; // skip on CI without qoder install
    const found = resolveRuntimeInfoBinary();
    // On this darwin-arm64 machine with qoder installed, should find something
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(found).toBeTruthy();
      expect(found).toMatch(/runtime-info/);
    }
  });
});
