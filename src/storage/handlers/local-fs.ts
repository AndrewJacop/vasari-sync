import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { hashFile } from "../../core/hash.js";
import type { RemoteFile, StorageBackend } from "../types.js";

/**
 * TEST-ONLY backend: a plain directory stands in for remote storage.
 * It is the backbone of every command-level integration test, so its
 * semantics mirror a real backend exactly (push copies in, pull copies
 * out, list walks, delete removes).
 */

export interface LocalFsConfig {
  /** Directory that acts as the remote storage root. */
  basePath: string;
}

/** Remote keys are always posix-style, even when running on Windows. */
function toLocalPath(basePath: string, remoteKey: string): string {
  return join(basePath, ...remoteKey.split("/"));
}

function toRemoteKey(basePath: string, localPath: string): string {
  return relative(basePath, localPath).split(sep).join("/");
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(abs)));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function notFound(remoteKey: string): Error {
  return new Error(`Remote file not found: ${remoteKey}`);
}

export class LocalFsHandler implements StorageBackend {
  constructor(private readonly config: LocalFsConfig) {
    if (!config.basePath) {
      throw new Error("local-fs backend requires a 'basePath' setting");
    }
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    const dest = toLocalPath(this.config.basePath, remoteKey);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(localPath, dest);
  }

  async pull(remoteKey: string, localPath: string): Promise<void> {
    const src = toLocalPath(this.config.basePath, remoteKey);
    await mkdir(dirname(localPath), { recursive: true });
    try {
      await copyFile(src, localPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(remoteKey);
      throw err;
    }
  }

  async list(prefix?: string): Promise<RemoteFile[]> {
    let absolute: string[];
    try {
      absolute = await walkFiles(this.config.basePath);
    } catch (err) {
      // An empty (never-written) backend lists as empty, like a fresh bucket.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const files: RemoteFile[] = [];
    for (const abs of absolute) {
      const key = toRemoteKey(this.config.basePath, abs);
      if (prefix !== undefined && !key.startsWith(prefix)) continue;
      const info = await stat(abs);
      files.push({
        path: key,
        size: info.size,
        etagOrHash: await hashFile(abs),
        modifiedAt: info.mtime.toISOString(),
      });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async delete(remoteKey: string): Promise<void> {
    try {
      await unlink(toLocalPath(this.config.basePath, remoteKey));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(remoteKey);
      throw err;
    }
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    const { basePath } = this.config;
    try {
      const info = await stat(basePath);
      return info.isDirectory()
        ? { ok: true, message: `connected to ${basePath}` }
        : { ok: false, message: `${basePath} is not a directory` };
    } catch {
      return { ok: false, message: `${basePath} does not exist` };
    }
  }
}
