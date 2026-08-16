import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { Octokit } from "@octokit/rest";
import type { RemoteFile, StorageBackend } from "../types.js";

/**
 * GitHub private-repo backend — the one backend with native versioning:
 * every push/delete is a real commit, so history comes free from git.
 * Files are stored under `remoteBasePath` (default: repo root) on a branch
 * (default: the repo's default branch) via the contents API — one file per
 * call, matching the StorageBackend interface.
 */
export interface GithubRepoConfig {
  owner: string;
  repo: string;
  /** Defaults to the repo's default branch (resolved on first API call). */
  branch?: string;
  /** Personal access token with repo read/write scope. */
  token: string;
  /** Directory under the repo root; created implicitly on first push. */
  remoteBasePath?: string;
}

const REQUIRED: (keyof GithubRepoConfig)[] = ["owner", "repo", "token"];

function notFound(remoteKey: string): Error {
  return new Error(`Remote file not found: ${remoteKey}`);
}

/** Octokit maps HTTP failures to RequestError carrying `.status`. */
function status(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

function isNotFound(err: unknown): boolean {
  return status(err) === 404;
}

/** One entry of a contents-API directory listing. */
interface ContentEntry {
  type: "file" | "dir";
  name: string;
  path: string;
  size: number;
  sha: string;
}

export class GithubRepoHandler implements StorageBackend {
  /** github-repo only — every other handler leaves this undefined. */
  readonly capabilities = { nativeVersioning: true };

  private readonly octokit: Octokit;

  constructor(private readonly config: GithubRepoConfig) {
    const missing = REQUIRED.filter((key) => !this.config[key]);
    if (missing.length > 0) {
      throw new Error(`github-repo backend missing required settings: ${missing.join(", ")}`);
    }
    this.octokit = new Octokit({ auth: config.token, userAgent: "vasari-sync" });
  }

  /** Remote keys are posix-style; the base path sits under the repo root. */
  private remotePath(remoteKey: string): string {
    return posix.join(this.config.remoteBasePath ?? "", ...remoteKey.split("/"));
  }

  private ref(): { ref?: string } {
    // Omit `ref` entirely when unset so the API uses the default branch.
    return this.config.branch !== undefined ? { ref: this.config.branch } : {};
  }

  /** Current blob sha of a remote file, or undefined if it doesn't exist yet. */
  private async currentSha(remote: string): Promise<string | undefined> {
    try {
      const res = await this.octokit.repos.getContent({
        owner: this.config.owner,
        repo: this.config.repo,
        path: remote,
        ...this.ref(),
      });
      if (Array.isArray(res.data) || res.data.type !== "file") return undefined;
      return res.data.sha;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    const remote = this.remotePath(remoteKey);
    // The contents API takes the full base64 body in JSON — no streaming.
    // vsync files are config-sized (scanner suppresses large files), and
    // GitHub caps this endpoint at 100MB anyway.
    const content = await readFile(localPath);
    // Overwrite semantics like every backend: fetch the current sha first
    // (create without sha on an existing path is a 409).
    const sha = await this.currentSha(remote);
    await this.octokit.repos.createOrUpdateFileContents({
      owner: this.config.owner,
      repo: this.config.repo,
      path: remote,
      message: `vsync: ${sha === undefined ? "add" : "update"} ${remote}`,
      content: content.toString("base64"),
      ...(this.config.branch !== undefined ? { branch: this.config.branch } : {}),
      ...(sha !== undefined ? { sha } : {}),
    });
  }

  async pull(remoteKey: string, localPath: string): Promise<void> {
    const remote = this.remotePath(remoteKey);
    let buf: Buffer;
    try {
      const res = await this.octokit.repos.getContent({
        owner: this.config.owner,
        repo: this.config.repo,
        path: remote,
        ...this.ref(),
      });
      if (Array.isArray(res.data) || res.data.type !== "file") {
        throw new Error(`Remote path is not a file: ${remoteKey}`);
      }
      // octokit types `encoding` as plain string; the contents API
      // documents only base64/none — narrow for Buffer.from's signature.
      const encoding = (res.data.encoding ?? "base64") as BufferEncoding;
      buf = Buffer.from(res.data.content ?? "", encoding);
    } catch (err) {
      if (isNotFound(err)) throw notFound(remoteKey);
      throw err;
    }
    // Only touch the local filesystem once the remote fetch fully succeeded.
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, buf);
  }

  async list(prefix?: string): Promise<RemoteFile[]> {
    const base = this.config.remoteBasePath ?? "";
    const files: RemoteFile[] = [];
    // Recursive shallow walk: one contents call per directory. Scoped to
    // our subtree, so it never fetches the rest of the repo.
    const walk = async (dirRel: string): Promise<void> => {
      let entries: ContentEntry[];
      try {
        const res = await this.octokit.repos.getContent({
          owner: this.config.owner,
          repo: this.config.repo,
          path: posix.join(base, dirRel),
          ...this.ref(),
        });
        if (!Array.isArray(res.data)) return;
        entries = res.data as ContentEntry[];
      } catch (err) {
        // A never-pushed backend (base path missing) lists as empty, like
        // a fresh bucket.
        if (isNotFound(err) && dirRel === "") return;
        throw err;
      }
      for (const entry of entries) {
        // name + walk dir is the key relative to the base path, regardless
        // of entry.path being repo-root-relative.
        const key = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.type === "dir") {
          await walk(key);
        } else {
          files.push({
            path: key,
            size: entry.size,
            // The git blob sha is a content hash — a perfect change indicator.
            etagOrHash: entry.sha,
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
    const remote = this.remotePath(remoteKey);
    // The delete endpoint requires the blob sha — fetch it first.
    const sha = await this.currentSha(remote);
    if (sha === undefined) throw notFound(remoteKey);
    await this.octokit.repos.deleteFile({
      owner: this.config.owner,
      repo: this.config.repo,
      path: remote,
      sha,
      message: `vsync: delete ${remote}`,
      ...(this.config.branch !== undefined ? { branch: this.config.branch } : {}),
    });
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    let defaultBranch: string;
    try {
      const res = await this.octokit.repos.get({
        owner: this.config.owner,
        repo: this.config.repo,
      });
      defaultBranch = res.data.default_branch;
    } catch (err) {
      // GitHub returns 404 for private repos the token can't see (never
      // 403), so a failure here means repo-or-access, not just repo.
      if (status(err) === 404 || status(err) === 401) {
        return {
          ok: false,
          message: `cannot access ${this.config.owner}/${this.config.repo}: not found or token lacks access`,
        };
      }
      return {
        ok: false,
        message: `cannot access ${this.config.owner}/${this.config.repo}: ${(err as Error).message}`,
      };
    }
    const branch = this.config.branch ?? defaultBranch;
    try {
      await this.octokit.repos.getBranch({
        owner: this.config.owner,
        repo: this.config.repo,
        branch,
      });
    } catch (err) {
      if (status(err) === 404) {
        return {
          ok: false,
          message: `branch '${branch}' not found on ${this.config.owner}/${this.config.repo}`,
        };
      }
      return { ok: false, message: `cannot check branch '${branch}': ${(err as Error).message}` };
    }
    return {
      ok: true,
      message: `connected to ${this.config.owner}/${this.config.repo} (branch '${branch}')`,
    };
  }
}
