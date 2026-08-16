import { createBackend } from "../storage/registry.js";
import type { BackendConfig, StorageBackend } from "../storage/types.js";
import { withSpinner } from "../utils/progress.js";
import { readGlobalConfig, type GlobalConfig } from "./globalConfig.js";
import { readManifest } from "./manifest.js";

/** Constructs a backend handler from a profile: settings merged with that
 * backend's secrets from the global secret store. Handler constructors
 * validate required fields (token, credentials), so a secret-less merge
 * throws before any API call — never construct from settings alone. */
export function createBackendFromProfile(
  backendName: string,
  global: GlobalConfig,
): StorageBackend {
  const profile = global.profiles[backendName];
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(global.secrets)) {
    if (key.startsWith(`${backendName}/`)) {
      secrets[key.slice(backendName.length + 1)] = value;
    }
  }
  return withListingSpinner(
    createBackend(backendName, {
      ...(profile?.settings ?? {}),
      ...secrets,
    } as BackendConfig),
  );
}

/** Every remote listing gets a spinner — the one slow call shared by
 * status/diff/push/pull/link/list (a github-repo listing is several API
 * round-trips). Own-property assignment shadows the class prototype. */
function withListingSpinner(backend: StorageBackend): StorageBackend {
  const rawList = backend.list.bind(backend);
  backend.list = (prefix?: string) => withSpinner("Listing remote files", () => rawList(prefix));
  return backend;
}

/**
 * Resolves the storage backend for an initialized project: the manifest's
 * backend name + that backend's global profile settings and secrets. All
 * wiring lives machine-side (global config) — the committed manifest only
 * names the backend.
 */
export async function resolveBackend(
  projectRoot: string,
  homeDir?: string,
): Promise<StorageBackend> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }
  const globalConfig = await readGlobalConfig(homeDir);
  if (!globalConfig.profiles[manifest.backend]) {
    throw new Error(
      `No saved profile for '${manifest.backend}' on this machine — run \`vsync config\` first.`,
    );
  }
  return createBackendFromProfile(manifest.backend, globalConfig);
}
