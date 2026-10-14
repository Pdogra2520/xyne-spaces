// Decides whether a successful sandbox-* tool call should announce a live
// preview for the sandbox it used (XYNE-66338).
//
// A run can touch several sandboxes — typically the shared read-only sbx-git
// sandbox for reading code, then its own writable sandbox for the work. Each
// distinct writable sandbox is announced exactly once per run; shared /
// read-only sandboxes are never announced.

export type SandboxAnnounceDecision =
  | { announce: true; sandboxId: string }
  | { announce: false; reason: "no-session" | "shared-readonly" | "already-announced"; sandboxId?: string };

export interface SandboxAnnounceInput {
  /** Tool-call args; an explicit `sessionId` wins over the conversation binding. */
  toolArgs: unknown;
  /** The caller-scoped sandbox store key (the run's conversation binding). */
  storeKey: string;
  /** Sandbox IDs already announced in this run. */
  announced: ReadonlySet<string>;
  getSession: (key: string) => { id?: string } | undefined;
  isSharedOrReadOnly: (sandboxId: string) => boolean;
}

export function explicitSandboxSessionId(toolArgs: unknown): string | undefined {
  if (!toolArgs || typeof toolArgs !== "object") return undefined;
  const v = (toolArgs as { sessionId?: unknown }).sessionId;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function decideSandboxPreviewAnnounce(input: SandboxAnnounceInput): SandboxAnnounceDecision {
  const explicitId = explicitSandboxSessionId(input.toolArgs);
  const sbx = (explicitId ? input.getSession(explicitId) : undefined) ?? input.getSession(input.storeKey);
  const sandboxId = sbx?.id;
  if (!sandboxId) return { announce: false, reason: "no-session" };
  if (input.isSharedOrReadOnly(sandboxId)) return { announce: false, reason: "shared-readonly", sandboxId };
  if (input.announced.has(sandboxId)) return { announce: false, reason: "already-announced", sandboxId };
  return { announce: true, sandboxId };
}
