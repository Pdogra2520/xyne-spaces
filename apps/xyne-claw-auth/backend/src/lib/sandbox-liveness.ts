import { CONFIG } from "../config.js";
import { createLogger } from "../logger.js";
import { markSandboxArtifactsStale } from "./conversation-artifacts.js";

const log = createLogger("sandbox-liveness");

/** How long one sandbox's liveness answer is trusted before it is asked again. */
export const LIVENESS_RECHECK_MS = 5 * 60 * 1000;
/** Upper bound the artifact list waits for xyne-claw. */
const LIVENESS_TIMEOUT_MS = 1_500;
/** Matches xyne-claw's MAX_LIVENESS_IDS. */
const MAX_IDS_PER_CHECK = 50;
const MAX_TRACKED = 10_000;

const SANDBOX_KINDS = new Set(["PREVIEW", "DIFF"]);
const SANDBOX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

type Liveness = "alive" | "ended" | "unknown";

interface SandboxArtifactLike {
  kind: string;
  refService: string;
  refId: string;
  status: string;
}

/** sandboxId → when it was last sent for a check. Per pod; a miss only costs one lookup. */
const lastChecked = new Map<string, number>();

function remember(id: string, at: number): void {
  if (lastChecked.size >= MAX_TRACKED) {
    const oldest = lastChecked.keys().next().value;
    if (oldest !== undefined) lastChecked.delete(oldest);
  }
  lastChecked.delete(id);
  lastChecked.set(id, at);
}

/** Test hook. */
export function resetSandboxLivenessCache(): void {
  lastChecked.clear();
}

async function fetchLiveness(sandboxIds: string[]): Promise<Record<string, Liveness>> {
  const res = await fetch(`${CONFIG.xyneClawUrl}/internal/sandboxes/liveness`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(CONFIG.xyneClawS2sKey ? { "x-s2s-key": CONFIG.xyneClawS2sKey } : {}),
    },
    body: JSON.stringify({ sandboxIds }),
    signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { liveness?: unknown };
  const out: Record<string, Liveness> = {};
  if (body.liveness && typeof body.liveness === "object") {
    for (const [id, value] of Object.entries(body.liveness as Record<string, unknown>)) {
      if (value === "alive" || value === "ended" || value === "unknown") out[id] = value;
    }
  }
  return out;
}

/**
 * XYNE-66339: before the Workspace pane gets its artifact list, ask xyne-claw
 * whether the sandboxes behind ACTIVE preview / code-changes rows still exist.
 * Rows for ended sandboxes are marked STALE in the DB and returned as STALE, so
 * the pane shows "This sandbox has ended" for sandboxes that idled out, passed
 * their deadline or lost their pod, none of which call `sandbox-destroy`.
 *
 * Never fails the list: if xyne-claw is slow, down or answers `unknown`, the
 * rows come back unchanged. Each sandbox is asked about at most once per
 * LIVENESS_RECHECK_MS per pod.
 */
export async function applySandboxLiveness<T extends SandboxArtifactLike>(rows: T[], now = Date.now()): Promise<T[]> {
  const due: string[] = [];
  for (const row of rows) {
    if (row.refService !== "CLAW" || row.status !== "ACTIVE" || !SANDBOX_KINDS.has(row.kind)) continue;
    if (!SANDBOX_ID_RE.test(row.refId) || due.includes(row.refId)) continue;
    const at = lastChecked.get(row.refId);
    if (at !== undefined && now - at < LIVENESS_RECHECK_MS) continue;
    due.push(row.refId);
    if (due.length >= MAX_IDS_PER_CHECK) break;
  }
  if (due.length === 0) return rows;
  // Stamp before the call so concurrent list requests don't all ask again.
  for (const id of due) remember(id, now);

  let liveness: Record<string, Liveness>;
  try {
    liveness = await fetchLiveness(due);
  } catch (err) {
    log.warn(`liveness check skipped: ${err instanceof Error ? err.message : String(err)}`);
    return rows;
  }
  const ended = due.filter((id) => liveness[id] === "ended");
  if (ended.length === 0) return rows;

  try {
    await markSandboxArtifactsStale(ended);
  } catch (err) {
    log.warn(`marking ended sandboxes failed: ${err instanceof Error ? err.message : String(err)}`);
    return rows;
  }
  const endedSet = new Set(ended);
  return rows.map((row) =>
    row.refService === "CLAW" && SANDBOX_KINDS.has(row.kind) && row.status === "ACTIVE" && endedSet.has(row.refId)
      ? { ...row, status: "STALE" }
      : row,
  );
}
