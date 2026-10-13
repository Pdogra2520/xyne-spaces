import { describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock("../config.js", () => ({
  CONFIG: {
    xyneClawUrl: "http://claw.local",
    xyneClawS2sKey: "s2s",
    internalUrl: "http://auth.local",
    clawSseTransport: false,
    encryptionKey: Buffer.alloc(32, 7),
    defaultAgentSlug: "assistant",
    sessionSigningKey: "test-signing-key",
  },
}));

// Any model/method not named here resolves to null, which is what prepareRun
// treats as "nothing stored" on the happy path the forwardBody tests walk.
vi.mock("../db.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, model) =>
        model === "user"
          ? { findUnique: async () => ({ name: "U", email: "u@example.test", orgId: "org-1" }) }
          : model === "agent"
            ? {
                findUnique: async () => ({
                  id: "agent-1",
                  slug: "ask-ai",
                  enabled: true,
                  systemPrompt: "prompt",
                  orgId: "org-1",
                  config: {},
                  delegationTier: "standard",
                  skills: [],
                }),
              }
            : new Proxy({}, { get: () => async () => null }),
    },
  ),
}));
vi.mock("../redis.js", () => ({ redisService: { getConnection: () => ({}) } }));
vi.mock("xyne-claw-shared", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));

const { startRun, prepareRun, resolveGenerativeUi } = await import("./start-run.js");

describe("startRun validation failures", () => {
  const input = (body: Record<string, unknown>) => ({
    body,
    isInternalRun: true,
    isInternalS2SCaller: true,
    wantsSse: false,
  });

  it("returns ok:false with today's 400 for a missing task instead of throwing", async () => {
    const result = await startRun(input({ userId: "u1" }), {});

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "task is required and must be a non-empty string",
    });
  });

  it("returns ok:false with today's 400 for a blank task", async () => {
    const result = await startRun(input({ userId: "u1", task: "   " }), {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("task is required and must be a non-empty string");
  });

  it("returns ok:false with today's 400 for a non-string callbackUrl", async () => {
    const result = await startRun(input({ userId: "u1", task: "hi", callbackUrl: 7 }), {});

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "callbackUrl must be a string",
    });
  });

  it("returns ok:false with today's 400 for a malformed recordingRefs field", async () => {
    const result = await startRun(
      input({ userId: "u1", task: "hi", recordingRefs: "not-an-array" }),
      {},
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      error:
        "recordingRefs must contain at most four valid video references, each no larger than 1 GB",
    });
  });

  it("returns ok:false with today's 403 when a service token lacks runs:write", async () => {
    const result = await startRun(input({ userId: "u1", task: "hi" }), {
      serviceToken: {
        client: "service",
        scopes: ["agent:assistant"],
      } as never,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "This token does not have the runs:write scope",
    });
  });
});

describe("resolveGenerativeUi", () => {
  const ok = { isInternalRun: true, eventType: undefined, conversationId: "chat-123" };

  it("is on for an internal chat- run with no eventType", () => {
    expect(resolveGenerativeUi({ generativeUi: true }, ok)).toBe(true);
  });

  it.each([false, undefined, "true", 1, null, {}])("is off when the body value is %j", (value) => {
    expect(resolveGenerativeUi({ generativeUi: value }, ok)).toBe(false);
  });

  it("is off for an external (non-internal) caller", () => {
    expect(resolveGenerativeUi({ generativeUi: true }, { ...ok, isInternalRun: false })).toBe(false);
  });

  it.each(["APP_MENTIONED", "DIRECT_MESSAGE", "USER_MENTIONED", "scheduled_job", "automation", "awakening", "artifact_app"])(
    "is off when eventType is %s",
    (eventType) => {
      expect(resolveGenerativeUi({ generativeUi: true }, { ...ok, eventType })).toBe(false);
    },
  );

  it.each([undefined, "", "thread-1", "app_abc", "a2a_abc", "scheduled_abc", "C123"])(
    "is off for conversation id %j",
    (conversationId) => {
      expect(resolveGenerativeUi({ generativeUi: true }, { ...ok, conversationId })).toBe(false);
    },
  );
});

describe("prepareRun generativeUi forwarding", () => {
  const forwarded = async (
    body: Record<string, unknown>,
    isInternalRun = true,
  ): Promise<Record<string, unknown>> => {
    const result = await prepareRun(
      { body: { userId: "u1", task: "hi", agentSlug: "ask-ai", ...body }, isInternalRun, isInternalS2SCaller: isInternalRun, wantsSse: false },
      {},
    );
    if (!result.ok) throw new Error(`prepareRun refused: ${result.error}`);
    return result.prepared.forwardBody;
  };

  it("forwards generativeUi for an internal chat- run with no eventType", async () => {
    const body = await forwarded({ conversationId: "chat-abc", generativeUi: true });
    expect(body["generativeUi"]).toBe(true);
  });

  it.each([false, "true", 1, null])("does not forward when the body value is %j", async (value) => {
    const body = await forwarded({ conversationId: "chat-abc", generativeUi: value });
    expect("generativeUi" in body).toBe(false);
  });

  it("does not forward when absent", async () => {
    const body = await forwarded({ conversationId: "chat-abc" });
    expect("generativeUi" in body).toBe(false);
  });

  it.each(["APP_MENTIONED", "DIRECT_MESSAGE", "USER_MENTIONED", "scheduled_job", "awakening", "artifact_app"])(
    "does not forward with eventType %s even on a chat- conversation",
    async (eventType) => {
      const body = await forwarded({ conversationId: "chat-abc", generativeUi: true, eventType });
      expect("generativeUi" in body).toBe(false);
    },
  );

  it.each(["thread-1", "app_abc", "scheduled_abc"])("does not forward for conversation %s", async (conversationId) => {
    const body = await forwarded({ conversationId, generativeUi: true });
    expect("generativeUi" in body).toBe(false);
  });

  it("does not forward for a non-internal (cookie or service-token) caller", async () => {
    const body = await forwarded({ conversationId: "chat-abc", generativeUi: true }, false);
    expect("generativeUi" in body).toBe(false);
  });
});
