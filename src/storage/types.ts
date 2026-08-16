/**
 * Storage backend contract. Every backend implements this interface;
 * commands resolve backends through the registry and never import a
 * specific handler directly.
 */

/** One file as seen on the remote backend. */
export interface RemoteFile {
  /** Remote key, posix-style. */
  path: string;
  size: number;
  /** Backend-native change indicator, if available. */
  etagOrHash?: string;
  /** ISO date, if available. */
  modifiedAt?: string;
}

export interface BackendCapabilities {
  /** True only for github-repo (git gives it versioning for free). */
  nativeVersioning?: boolean;
}

export interface StorageBackend {
  /** Upload a local file to a remote key. */
  push(localPath: string, remoteKey: string): Promise<void>;
  /** Download a remote key to a local path. */
  pull(remoteKey: string, localPath: string): Promise<void>;
  /** List remote files whose key starts with `prefix` (all if omitted). */
  list(prefix?: string): Promise<RemoteFile[]>;
  /** Remove a remote file. */
  delete(remoteKey: string): Promise<void>;
  /** Cheap connectivity/access check, never throws. */
  testConnection(): Promise<{ ok: boolean; message?: string }>;
  capabilities?: BackendCapabilities;
}

/** Backend-specific settings bag; each handler validates its own shape. */
export type BackendConfig = Record<string, unknown>;

export type BackendFactory = (config: BackendConfig) => StorageBackend;
