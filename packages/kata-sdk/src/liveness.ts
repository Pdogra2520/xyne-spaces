import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";

const SANDBOXES_GROUP = "agents.x-k8s.io";
const VERSION = "v1alpha1";
const SANDBOXES_PLURAL = "sandboxes";
const DEFAULT_NAMESPACE = "xyne-apps";

/**
 * Whether a sandbox still exists.
 * - `alive`: the Sandbox object exists and is not being deleted.
 * - `ended`: the Sandbox object is gone (404) or is being deleted.
 * - `unknown`: the lookup failed for any other reason (API down, RBAC,
 *   timeout). Callers must treat this as "do not change anything".
 */
export type SandboxLiveness = "alive" | "ended" | "unknown";

export interface SandboxLivenessOptions {
  namespace?: string;
  k8sClient?: CustomObjectsApi;
}

let sharedClient: CustomObjectsApi | null = null;

function defaultClient(): CustomObjectsApi {
  if (!sharedClient) {
    const config = new KubeConfig();
    // Same resolution as KataClient: KUBECONFIG / ~/.kube/config locally, the
    // mounted service account in-cluster.
    config.loadFromDefault();
    sharedClient = config.makeApiClient(CustomObjectsApi);
  }
  return sharedClient;
}

function statusCodeOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { statusCode?: number } } | null;
  return e?.statusCode ?? e?.response?.statusCode;
}

/**
 * Look up one sandbox by name. The sandbox id Claw announces (`Session.id`) is
 * the Sandbox object's name, which is unique and never reused, so a 404 means
 * the sandbox has ended for good (destroyed, idled out, or past its claim's
 * shutdownTime).
 */
export async function getSandboxLiveness(
  sandboxId: string,
  options: SandboxLivenessOptions = {},
): Promise<SandboxLiveness> {
  try {
    const response = await (options.k8sClient ?? defaultClient()).getNamespacedCustomObject(
      SANDBOXES_GROUP,
      VERSION,
      options.namespace ?? DEFAULT_NAMESPACE,
      SANDBOXES_PLURAL,
      sandboxId,
    );
    const body = response.body as { metadata?: { deletionTimestamp?: unknown } } | null;
    return body?.metadata?.deletionTimestamp ? "ended" : "alive";
  } catch (err) {
    return statusCodeOf(err) === 404 ? "ended" : "unknown";
  }
}
