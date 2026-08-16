import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createClient, type FileStat, type WebDAVClient } from "webdav";
import type { RemoteFile, StorageBackend } from "../types.js";

/**
 * WebDAV backend, built on the `webdav` package (v5). Works against any
 * compliant server (Apache mod_dav, nginx dav module, Nextcloud/ownCloud,
 * Box, ...). Remote files live under `remoteBasePath` within the DAV
 * collection the `url` points at.
 */
export interface WebDavConfig {
  /** Base URL of the DAV collection (for Nextcloud: .../remote.php/dav/files/<user>). */
  url: string;
  username?: string;
  /** Password / Nextcloud app password. */
  password?: string;
  /** Directory under the DAV root; created on first push if missing. */
  remoteBasePath: string;
}

const REQUIRED: (keyof WebDavConfig)[] = ["url", "remoteBasePath"];

function notFound(remoteKey: string): Error {
  return new Error(`Remote file not found: ${remoteKey}`);
}

/** webdav-client maps HTTP failures to Errors carrying `.status`. */
function status(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

function isNotFound(err: unknown): boolean {
  return status(err) === 404;
}

export class WebDavHandler implements StorageBackend {
  private readonly client: WebDAVClient;

  constructor(private readonly config: WebDavConfig) {
    const missing = REQUIRED.filter((key) => !this.config[key]);
    if (missing.length > 0) {
      throw new Error(`webdav backend missing required settings: ${missing.join(", ")}`);
    }
    // Stateless HTTP client — no connection happens until the first request.
    this.client = createClient(config.url, {
      ...(config.username !== undefined ? { username: config.username } : {}),
      ...(config.password !== undefined ? { password: config.password } : {}),
    });
  }

  /** Remote keys are posix-style; the base path may be absolute or DAV-root-relative. */
  private remotePath(remoteKey: string): string {
    return posix.join(this.config.remoteBasePath, ...remoteKey.split("/"));
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    const remote = this.remotePath(remoteKey);
    // PUT into a missing collection is a 409 on most servers — create
    // parents first (recursive MKCOL stats each ancestor; skipped, not
    // re-created, when they already exist).
    await this.client.createDirectory(posix.dirname(remote), { recursive: true });
    // Passing a Readable streams the body without a Content-Length header,
    // so huge files never sit in memory.
    await this.client.putFileContents(remote, createReadStream(localPath));
  }

  async pull(remoteKey: string, localPath: string): Promise<void> {
    const remote = this.remotePath(remoteKey);
    await mkdir(dirname(localPath), { recursive: true });
    try {
      await pipeline(this.client.createReadStream(remote), createWriteStream(localPath));
    } catch (err) {
      // Never leave a truncated/empty local file behind a failed download.
      await rm(localPath, { force: true });
      if (isNotFound(err)) throw notFound(remoteKey);
      throw err;
    }
  }

  async list(prefix?: string): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    // Depth:1 PROPFIND per directory (not deep:true) — Apache disables
    // Depth-infinity PROPFIND by default, and a shallow walk works everywhere.
    const walk = async (dirRel: string): Promise<void> => {
      let entries: FileStat[];
      try {
        entries = await this.client.getDirectoryContents(this.remotePath(dirRel));
      } catch (err) {
        // A never-written backend (base path missing) lists as empty, like a fresh bucket.
        if (isNotFound(err) && dirRel === "") return;
        throw err;
      }
      for (const entry of entries) {
        // basename + walk dir is reliable regardless of how the library
        // normalizes absolute vs url-relative filenames.
        const key = dirRel ? `${dirRel}/${entry.basename}` : entry.basename;
        if (entry.type === "directory") {
          await walk(key);
        } else {
          files.push({
            path: key,
            size: entry.size,
            // Some servers quote etags ("\"abc\"") — store them bare, like s3.
            etagOrHash: entry.etag?.replace(/^"|"$/g, "") || undefined,
            modifiedAt: new Date(entry.lastmod).toISOString(),
          });
        }
      }
    };
    await walk("");
    return files
      .filter((f) => prefix === undefined || f.path.startsWith(prefix))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async delete(remoteKey: string): Promise<void> {
    try {
      await this.client.deleteFile(this.remotePath(remoteKey));
    } catch (err) {
      // WebDAV DELETE is not idempotent (404 on missing, like local-fs/sftp).
      if (isNotFound(err)) throw notFound(remoteKey);
      throw err;
    }
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    const base = this.config.remoteBasePath;
    try {
      // options.details defaults false, but the return type stays a union — narrow it.
      const stat = (await this.client.stat(base)) as FileStat;
      if (stat.type === "directory") {
        return { ok: true, message: `connected to ${this.config.url} (base path '${base}')` };
      }
      return { ok: false, message: `remote base path '${base}' exists but is not a directory` };
    } catch (err) {
      if (isNotFound(err)) {
        return {
          ok: true,
          message: `connected to ${this.config.url} (base path '${base}' will be created on first push)`,
        };
      }
      return { ok: false, message: `cannot access ${this.config.url}: ${(err as Error).message}` };
    }
  }
}
