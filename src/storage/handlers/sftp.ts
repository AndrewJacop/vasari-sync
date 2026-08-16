import { mkdir, readFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import Client from "ssh2-sftp-client";
import type { FileInfo } from "ssh2-sftp-client";
import type { RemoteFile, StorageBackend } from "../types.js";

/**
 * SFTP/SSH backend, built on ssh2-sftp-client. Supports password and
 * private-key auth. Remote files live under `remoteBasePath`, addressed
 * posix-style (absolute or relative to the login dir).
 */
export interface SftpConfig {
  host: string;
  port?: number;
  username: string;
  /** Password auth (mutually independent of privateKeyPath — one of the two is required). */
  password?: string;
  /** Path to a private key file on the LOCAL machine for key-based auth. */
  privateKeyPath?: string;
  /** Root directory on the remote host; created on first push if missing. */
  remoteBasePath: string;
}

const REQUIRED: (keyof SftpConfig)[] = ["host", "username", "remoteBasePath"];

function notFound(remoteKey: string): Error {
  return new Error(`Remote file not found: ${remoteKey}`);
}

/**
 * ssh2-sftp-client wraps failures so that `err.code` is either an SFTP
 * status code (2 = SSH_FX_NO_SUCH_FILE), an errno string ("ENOENT"), or
 * one of its custom codes. Any of those shapes means "not found".
 */
function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  return e?.code === "ENOENT" || e?.code === 2 || /no such file/i.test(String(e?.message ?? ""));
}

export class SftpHandler implements StorageBackend {
  private connection?: Promise<Client>;

  constructor(private readonly config: SftpConfig) {
    const missing = REQUIRED.filter((key) => !this.config[key]);
    if (missing.length > 0) {
      throw new Error(`sftp backend missing required settings: ${missing.join(", ")}`);
    }
    if (!config.password && !config.privateKeyPath) {
      throw new Error("sftp backend requires 'password' or 'privateKeyPath'");
    }
  }

  /** Lazy shared connection: one SSH handshake per handler lifetime. */
  private sftp(): Promise<Client> {
    this.connection ??= (async () => {
      let privateKey: Buffer | undefined;
      if (this.config.privateKeyPath) {
        try {
          privateKey = await readFile(this.config.privateKeyPath);
        } catch (err) {
          throw new Error(
            `cannot read privateKeyPath '${this.config.privateKeyPath}': ${(err as Error).message}`,
          );
        }
      }
      const client = new Client();
      try {
        await client.connect({
          host: this.config.host,
          port: this.config.port ?? 22,
          username: this.config.username,
          ...(this.config.password ? { password: this.config.password } : {}),
          ...(privateKey ? { privateKey } : {}),
        });
      } catch (err) {
        throw new Error(
          `cannot connect to ${this.config.host}:${this.config.port ?? 22} as ${this.config.username}: ${(err as Error).message}`,
        );
      }
      return client;
    })();
    return this.connection;
  }

  /** Remote keys are posix-style; the base may be absolute or login-relative. */
  private remotePath(remoteKey: string): string {
    return posix.join(this.config.remoteBasePath, ...remoteKey.split("/"));
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    const client = await this.sftp();
    const remote = this.remotePath(remoteKey);
    // Recursive mkdir is idempotent and throws only if something occupies
    // the path as a file. put() streams via read/write streams (unlike
    // fastPut, no glob expansion — filenames like "a[1].env" are safe).
    await client.mkdir(posix.dirname(remote), true);
    await client.put(localPath, remote);
  }

  async pull(remoteKey: string, localPath: string): Promise<void> {
    const client = await this.sftp();
    await mkdir(dirname(localPath), { recursive: true });
    try {
      await client.get(this.remotePath(remoteKey), localPath);
    } catch (err) {
      if (isNotFound(err)) throw notFound(remoteKey);
      throw err;
    }
  }

  async list(prefix?: string): Promise<RemoteFile[]> {
    const client = await this.sftp();
    const base = this.config.remoteBasePath;
    const files: RemoteFile[] = [];
    const walk = async (dirRel: string): Promise<void> => {
      let entries: FileInfo[];
      try {
        entries = await client.list(posix.join(base, dirRel));
      } catch (err) {
        // A never-written backend (base path missing) lists as empty, like a fresh bucket.
        if (isNotFound(err) && dirRel === "") return;
        throw err;
      }
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        const key = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.type === "d") {
          await walk(key);
        } else if (entry.type === "-") {
          // v12 reports modifyTime in ms (the @types package lags at seconds)
          files.push({
            path: key,
            size: entry.size,
            modifiedAt: new Date(entry.modifyTime).toISOString(),
          });
        }
        // type "l" (symlink) skipped, like local-fs skips non-regular files.
      }
    };
    await walk("");
    return files
      .filter((f) => prefix === undefined || f.path.startsWith(prefix))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async delete(remoteKey: string): Promise<void> {
    const client = await this.sftp();
    try {
      await client.delete(this.remotePath(remoteKey));
    } catch (err) {
      // SFTP delete is not idempotent (native semantics: error on missing).
      if (isNotFound(err)) throw notFound(remoteKey);
      throw err;
    }
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    const { host, port, username, remoteBasePath } = this.config;
    try {
      const client = await this.sftp();
      const type = await client.exists(remoteBasePath);
      if (type === "d") {
        return { ok: true, message: `connected to ${host}:${port ?? 22} as ${username}` };
      }
      if (type === false) {
        return {
          ok: true,
          message: `connected to ${host}:${port ?? 22} as ${username} (base path '${remoteBasePath}' will be created on first push)`,
        };
      }
      return {
        ok: false,
        message: `remote base path '${remoteBasePath}' exists but is not a directory`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Not part of StorageBackend — lets long-lived callers release the SSH session. */
  async close(): Promise<void> {
    try {
      (await this.connection)?.end();
    } catch {
      // never connected — nothing to release
    }
    this.connection = undefined;
  }
}
