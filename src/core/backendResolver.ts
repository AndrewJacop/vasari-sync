import { createBackend } from "../storage/registry.js";
import type { BackendConfig, StorageBackend } from "../storage/types.js";
import { readGlobalConfig } from "./globalConfig.js";
import { readProjectConfig } from "./projectConfig.js";

/**
 * Resolves the storage backend for an initialized project: the project
 * config's backend name + settings, with that backend's secrets merged in
 * from the global secret store (`${backend}/…` keys). The committed project
 * config stays secret-free while credentials stay global — this is the same
 * resolution `init` uses, extracted here so push/pull resolve identically.
 */
export async function resolveBackend(
  projectRoot: string,
  homeDir?: string,
): Promise<StorageBackend> {
  const projectConfig = await readProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No .vsync/config.json found — run `vsync init` in this project first.");
  }
  const globalConfig = await readGlobalConfig(homeDir);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalConfig.secrets)) {
    if (key.startsWith(`${projectConfig.backend}/`)) {
      secrets[key.slice(projectConfig.backend.length + 1)] = value;
    }
  }
  return createBackend(projectConfig.backend, {
    ...projectConfig.settings,
    ...secrets,
  } as BackendConfig);
}
