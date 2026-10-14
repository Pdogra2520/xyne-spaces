import { describe, expect, it, vi } from "vitest";
import { checkSandboxLiveness, MAX_LIVENESS_IDS } from "./liveness.js";

describe("checkSandboxLiveness (XYNE-66339)", () => {
  it("looks up each valid id once in the given namespace", async () => {
    const lookup = vi.fn(async (id: string) => (id === "sbx-dead" ? ("ended" as const) : ("alive" as const)));
    const out = await checkSandboxLiveness(["sbx-live", "sbx-dead", "sbx-live", " sbx-dead "], { lookup, namespace: "ns-a" });
    expect(out).toEqual({ "sbx-live": "alive", "sbx-dead": "ended" });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith("sbx-live", "ns-a");
  });

  it("drops malformed and non-string ids without looking them up", async () => {
    const lookup = vi.fn(async () => "alive" as const);
    const out = await checkSandboxLiveness(["../etc", "", 42, null, "-bad", "a".repeat(64)], { lookup, namespace: "ns" });
    expect(out).toEqual({});
    expect(lookup).not.toHaveBeenCalled();
  });

  it("caps the number of ids checked", async () => {
    const lookup = vi.fn(async () => "alive" as const);
    const ids = Array.from({ length: MAX_LIVENESS_IDS + 10 }, (_, i) => `sbx-${i}`);
    const out = await checkSandboxLiveness(ids, { lookup, namespace: "ns" });
    expect(Object.keys(out)).toHaveLength(MAX_LIVENESS_IDS);
  });

  it("reports unknown when a lookup throws", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await checkSandboxLiveness(["sbx-1"], { lookup, namespace: "ns" })).toEqual({ "sbx-1": "unknown" });
  });

  it("reports unknown when a lookup hangs", async () => {
    vi.useFakeTimers();
    try {
      const pending = checkSandboxLiveness(["sbx-1"], { lookup: () => new Promise(() => {}), namespace: "ns" });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(await pending).toEqual({ "sbx-1": "unknown" });
    } finally {
      vi.useRealTimers();
    }
  });
});
