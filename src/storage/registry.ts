import { LocalFsHandler, type LocalFsConfig } from "./handlers/local-fs.js";
import { S3Handler, type S3Config } from "./handlers/s3.js";
import { SftpHandler, type SftpConfig } from "./handlers/sftp.js";
import { WebDavHandler, type WebDavConfig } from "./handlers/webdav.js";
import type { BackendConfig, BackendFactory, StorageBackend } from "./types.js";

/**
 * The ONLY file allowed to know all handler implementations exist.
 * Adding a backend = one new handler file + one line below; nothing else
 * changes. (`local-fs` is the test-only backend every integration test
 * resolves through this same registry.)
 */
const registry: Record<string, BackendFactory> = {
  "local-fs": (config) => new LocalFsHandler(config as unknown as LocalFsConfig),
  s3: (config) => new S3Handler(config as unknown as S3Config),
  sftp: (config) => new SftpHandler(config as unknown as SftpConfig),
  webdav: (config) => new WebDavHandler(config as unknown as WebDavConfig),
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
