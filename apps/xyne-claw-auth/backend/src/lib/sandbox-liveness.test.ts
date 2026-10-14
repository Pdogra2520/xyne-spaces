import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  marked: [] as string[][],
  markThrows: false,
}));

vi.mock("../config.js", () => ({
  CONFIG: { xyneClawUrl: "http://claw.test", xyneClawS2sKey: "s2s-key" },
}));

vi.mock("./conversation-artifacts.js", () => ({
  markSandboxArtifactsStale: vi.fn(async (ids: string[]) => {
    if (state.markThrows) throw new Error("db down");
    state.marked.push(ids);
    return ids.length;
  }),
}));

const { applySandboxLiveness, resetSandboxLivenessCache, LIVENESS_RECHECK_MS } = await import("./sandbox-liveness.js");

const row = (refId: string, kind = "PREVIEW", status = "ACTIVE", refService = "CLAW") => ({ id: `${kind}-${refId}`, kind, refService, refId, status });

function mockClaw(liveness: Record<string, string> | Error, status = 200) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    if (liveness instanceof Error) throw liveness;
    void init;
    return new Response(JSON.stringify({ success: status === 200, liveness }), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("applySandboxLiveness (XYNE-66339)", () => {
  beforeEach(() => {
    resetSandboxLivenessCache();
    state.marked = [];
    state.markThrows = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks xyne-claw about ACTIVE sandbox rows only, once per sandbox, with the S2S key", async () => {
    const fetchMock = mockClaw({ "sbx-1": "alive" });
    const rows = [
      row("sbx-1", "PREVIEW"),
      row("sbx-1", "DIFF"),
      row("sbx-2", "PREVIEW", "STALE"),
      row("canvas-1", "CANVAS", "ACTIVE", "SPACES"),
      row("../bad"),
    ];
    expect(await applySandboxLiveness(rows)).toBe(rows);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://claw.test/internal/sandboxes/liveness");
    expect(JSON.parse(String(init.body))).toEqual({ sandboxIds: ["sbx-1"] });
    expect((init.headers as Record<string, string>)["x-s2s-key"]).toBe("s2s-key");
  });

  it("marks ended sandboxes STALE and returns their rows as STALE", async () => {
    mockClaw({ "sbx-1": "ended", "sbx-2": "alive", "sbx-3": "unknown" });
    const out = await applySandboxLiveness([row("sbx-1"), row("sbx-1", "DIFF"), row("sbx-2"), row("sbx-3")]);
    expect(out.map((r) => r.status)).toEqual(["STALE", "STALE", "ACTIVE", "ACTIVE"]);
    expect(state.marked).toEqual([["sbx-1"]]);
  });

  it("does not ask again within the recheck window, and asks again after it", async () => {
    const fetchMock = mockClaw({ "sbx-1": "alive" });
    await applySandboxLiveness([row("sbx-1")], 1_000);
    await applySandboxLiveness([row("sbx-1")], 1_000 + LIVENESS_RECHECK_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await applySandboxLiveness([row("sbx-1")], 1_000 + LIVENESS_RECHECK_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns rows unchanged when xyne-claw is down or errors", async () => {
    mockClaw(new Error("ECONNREFUSED"));
    const rows = [row("sbx-1")];
    expect(await applySandboxLiveness(rows)).toBe(rows);
    resetSandboxLivenessCache();
    mockClaw({}, 503);
    expect(await applySandboxLiveness(rows)).toBe(rows);
    expect(state.marked).toEqual([]);
  });

  it("returns rows unchanged when marking fails", async () => {
    mockClaw({ "sbx-1": "ended" });
    state.markThrows = true;
    const rows = [row("sbx-1")];
    expect(await applySandboxLiveness(rows)).toBe(rows);
  });

  it("ignores values outside alive/ended/unknown", async () => {
    mockClaw({ "sbx-1": "gone" });
    const out = await applySandboxLiveness([row("sbx-1")]);
    expect(out[0]?.status).toBe("ACTIVE");
    expect(state.marked).toEqual([]);
  });
});
