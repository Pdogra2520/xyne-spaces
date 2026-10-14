import { getSandboxLiveness, type SandboxLiveness } from "@xyne/kata-sdk";

/** Sandbox names are Kubernetes object names; same check as claw-auth's sandbox router. */
const SANDBOX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

export const MAX_LIVENESS_IDS = 50;
const PER_ID_TIMEOUT_MS = 3_000;

export type { SandboxLiveness };

function withTimeout(promise: Promise<SandboxLiveness>, ms: number): Promise<SandboxLiveness> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unknown"), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve("unknown");
      },
    );
  });
}

/**
 * XYNE-66339: report whether each sandbox still exists, so claw-auth can mark
 * the previews of sandboxes that ended without a `sandbox-destroy` call (idle
 * timeout, claim shutdownTime, lost pod) as STALE.
 *
 * The namespace resolves from the platform env only (KATA_NAMESPACE is a
 * platform-only key), never from a caller. Malformed ids and anything past
 * MAX_LIVENESS_IDS are left out of the result. Lookups that fail or exceed
 * PER_ID_TIMEOUT_MS come back `unknown`.
 */
export async function checkSandboxLiveness(
  sandboxIds: readonly unknown[],
  deps: { lookup?: (id: string, namespace: string) => Promise<SandboxLiveness>; namespace?: string } = {},
): Promise<Record<string, SandboxLiveness>> {
  const namespace = deps.namespace ?? (process.env["KATA_NAMESPACE"] || "xyne-apps");
  const lookup = deps.lookup ?? ((id: string, ns: string) => getSandboxLiveness(id, { namespace: ns }));
  const ids = [
    ...new Set(
      sandboxIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter((id) => SANDBOX_ID_RE.test(id)),
    ),
  ].slice(0, MAX_LIVENESS_IDS);
  const entries = await Promise.all(
    ids.map(async (id) => [id, await withTimeout(lookup(id, namespace), PER_ID_TIMEOUT_MS)] as const),
  );
  return Object.fromEntries(entries);
}
