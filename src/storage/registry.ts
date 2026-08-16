import { LocalFsHandler, type LocalFsConfig } from "./handlers/local-fs.js";
import type { BackendConfig, BackendFactory, StorageBackend } from "./types.js";

/**
 * The ONLY file allowed to know all handler implementations exist.
 * Adding a backend = one new handler file + one line below; nothing else
 * changes. (`local-fs` is the test-only backend every integration test
 * resolves through this same registry.)
 */
const registry: Record<string, BackendFactory> = {
  "local-fs": (config) => new LocalFsHandler(config as unknown as LocalFsConfig),
};

export function availableBackends(): string[] {
  return Object.keys(registry).sort();
}

export function createBackend(name: string, config: BackendConfig): StorageBackend {
  const factory = registry[name];
  if (!factory) {
    throw new Error(`Unknown backend '${name}', available: ${availableBackends().join(", ")}`);
  }
  return factory(config);
}
