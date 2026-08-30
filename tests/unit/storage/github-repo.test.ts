import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubRepoHandler } from "../../../src/storage/handlers/github-repo.js";
import type { GithubRepoConfig } from "../../../src/storage/handlers/github-repo.js";
import { createBackend } from "../../../src/storage/registry.js";
import type { BackendConfig, StorageBackend } from "../../../src/storage/types.js";

/**
 * All GitHub traffic is faked via vi.mock("@octokit/rest") — no network, no
 * token. The fake mimics real contents-API semantics closely enough to catch
 * handler bugs: updating an existing path without its current blob sha is
 * rejected (409), delete requires the exact sha (404 on missing path),
 * directory listings return only direct children, 404s carry `.status`, and
 * private repos the token can't see 404 (never 403). Blob shas are
 * content-derived so a stale-sha update genuinely fails.
 */

const h = vi.hoisted(() => {
  const blobSha = (buf: Buffer) => `blob-${createHash("sha1").update(buf).digest("hex")}`;
  const state = {
    // repo-root-relative path -> stored content
    files: new Map<string, Buffer>(),
    branches: new Set<string>(["main", "vsync"]),
    repoStatus: null as number | null, // 404/401 to fail repos.get
    repoError: null as Error | null, // transport failure for repos.get
    repoSize: 100, // KB; 0 = empty repo (default branch may not exist yet)
    commits: [] as Array<{ message: string; branch?: string; path: string }>,
    clients: [] as Array<{ auth: string; userAgent: string; log: Record<string, unknown> }>,
  };
  const err = (message: string, code: number) =>
    Object.assign(new Error(message), { status: code });

  class FakeOctokit {
    git = {
      async getBlob({ file_sha }: { file_sha: string }) {
        const hit = [...state.files.entries()].find(([, b]) => blobSha(b) === file_sha);
        if (!hit) throw err(`no blob '${file_sha}'`, 404);
        return { data: { content: hit[1].toString("base64"), encoding: "base64", size: hit[1].length } };
      },
    };
    repos = {
      async getContent({ path, ref }: { path: string; ref?: string }) {
        if (ref !== undefined && !state.branches.has(ref)) throw err(`no ref '${ref}'`, 404);
        const buf = state.files.get(path);
        if (buf) {
          // Real GitHub: reads over 1 MB get no content and encoding "none"
          // — the handler must fall back to the git blobs API for those.
          const big = buf.length > 1_000_000;
          return {
            data: {
              type: "file",
              path,
              sha: blobSha(buf),
              size: buf.length,
              ...(big ? { encoding: "none" } : { encoding: "base64", content: buf.toString("base64") }),
            },
          };
        }
        const prefix = path ? `${path}/` : "";
        const descendants = [...state.files.keys()].filter((k) => k.startsWith(prefix));
        if (descendants.length === 0) throw err(`no path '${path}'`, 404);
        // direct children only — nested files surface via their parent dir
        const names = new Set(descendants.map((k) => k.slice(prefix.length).split("/")[0]));
        return {
          data: [...names].sort().map((name) => {
            const full = `${prefix}${name}`;
            const child = state.files.get(full);
            return child
              ? { type: "file", name, path: full, size: child.length, sha: blobSha(child) }
              : { type: "dir", name, path: full, size: 0, sha: `tree-${name}` };
          }),
        };
      },
      async createOrUpdateFileContents({
        path,
        content,
        message,
        branch,
        sha,
      }: {
        path: string;
        content: string;
        message: string;
        branch?: string;
        sha?: string;
      }) {
        if (branch !== undefined && !state.branches.has(branch))
          throw err(`no branch '${branch}'`, 404);
        const existing = state.files.get(path);
        if (existing && blobSha(existing) !== sha) {
          // covers both "no sha supplied" and "stale sha" — GitHub rejects both
          throw err(`sha mismatch on '${path}'`, 409);
        }
        const buf = Buffer.from(content, "base64");
        state.files.set(path, buf);
        state.commits.push({ message, branch, path });
      },
      async deleteFile({
        path,
        sha,
        message,
        branch,
      }: {
        path: string;
        sha: string;
        message: string;
        branch?: string;
      }) {
        if (branch !== undefined && !state.branches.has(branch))
          throw err(`no branch '${branch}'`, 404);
        const existing = state.files.get(path);
        if (!existing) throw err(`no path '${path}'`, 404);
        if (sha !== blobSha(existing)) throw err(`sha mismatch on '${path}'`, 409);
        state.files.delete(path);
        state.commits.push({ message, branch, path });
      },
      async get() {
        if (state.repoError) throw state.repoError;
        if (state.repoStatus !== null)
          throw err(`repo status ${state.repoStatus}`, state.repoStatus);
        return {
          data: { default_branch: "main", full_name: "acme/secrets", size: state.repoSize },
        };
      },
      async getBranch({ branch }: { branch: string }) {
        if (!state.branches.has(branch)) throw err(`no branch '${branch}'`, 404);
        return { data: { name: branch } };
      },
    };
  }
  return { state, FakeOctokit, blobSha };
});

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    constructor(options: { auth: string; userAgent: string; log: Record<string, unknown> }) {
      h.state.clients.push(options);
      return new h.FakeOctokit();
    }
  },
}));

const OWNER = "acme";
const REPO = "secrets";
const CONFIG: GithubRepoConfig = {
  owner: OWNER,
  repo: REPO,
  branch: "vsync",
  token: "ghp_test-token",
  remoteBasePath: "vsync-store",
};
/** No branch, no base path — exercises the defaults (repo root, default branch). */
const ROOT_CONFIG: GithubRepoConfig = { owner: OWNER, repo: REPO, token: "ghp_test-token" };

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "vsync-ghrepo-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});
beforeEach(() => {
  h.state.files.clear();
  h.state.commits.length = 0;
  h.state.clients.length = 0;
  h.state.branches.clear();
  h.state.branches.add("main");
  h.state.branches.add("vsync");
  h.state.repoStatus = null;
  h.state.repoError = null;
  h.state.repoSize = 100;
});
afterEach(() => vi.restoreAllMocks());

const KEY = "some/nested/hello.txt";
const REMOTE = `vsync-store/${KEY}`;
// non-UTF8 bytes prove the base64 encode/decode round-trip, not just text
const CONTENT = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x41, 0x0a]);
const LOCAL = () => join(workDir, "hello.bin");

describe("github-repo handler config validation", () => {
  it("throws a clear error listing every missing required setting", () => {
    expect(() => new GithubRepoHandler({} as unknown as GithubRepoConfig)).toThrow(
      /github-repo backend missing required settings: owner, repo, token/,
    );
  });
});

describe("github-repo handler (faked Octokit)", () => {
  it("authenticates the Octokit client with the configured token", () => {
    new GithubRepoHandler(CONFIG);
    expect(h.state.clients).toEqual([
      { auth: "ghp_test-token", userAgent: "vasari-sync", log: expect.anything() },
    ]);
    // The logger must be fully no-op — Octokit's request-log plugin would
    // otherwise print every expected 404 existence check to the terminal.
    const { log } = h.state.clients[0];
    expect(Object.values(log).every((fn) => (fn as () => void)() === undefined)).toBe(true);
  });

  it("push commits a new file under the base path on the configured branch", async () => {
    await writeFile(LOCAL(), CONTENT);
    await new GithubRepoHandler(CONFIG).push(LOCAL(), KEY);
    expect(h.state.files.get(REMOTE)).toEqual(CONTENT);
    expect(h.state.commits).toEqual([
      { message: `vsync: add ${REMOTE}`, branch: "vsync", path: REMOTE },
    ]);
  });

  it("push overwrites by fetching the current blob sha first (no 409)", async () => {
    await writeFile(LOCAL(), CONTENT);
    const handler = new GithubRepoHandler(CONFIG);
    await handler.push(LOCAL(), KEY);
    const updated = Buffer.from("v2");
    await writeFile(LOCAL(), updated);
    await handler.push(LOCAL(), KEY);
    expect(h.state.files.get(REMOTE)).toEqual(updated);
    expect(h.state.commits.map((c) => c.message)).toEqual([
      `vsync: add ${REMOTE}`,
      `vsync: update ${REMOTE}`,
    ]);
  });

  it("push without branch/basePath settings commits to the default branch at repo root", async () => {
    await writeFile(LOCAL(), CONTENT);
    await new GithubRepoHandler(ROOT_CONFIG).push(LOCAL(), "plain.env");
    expect(h.state.files.get("plain.env")).toEqual(CONTENT);
    expect(h.state.commits).toEqual([
      { message: "vsync: add plain.env", branch: undefined, path: "plain.env" },
    ]);
    // the fake rejects pushes to branches that don't exist — undefined
    // branch is accepted, so it must reach the real default branch
  });

  it("push → list → pull → delete round-trip: sorted, prefix-filtered, sha etag, exact bytes", async () => {
    await writeFile(LOCAL(), CONTENT);
    const handler = new GithubRepoHandler(CONFIG);
    await handler.push(LOCAL(), KEY);
    await handler.push(LOCAL(), "zzz.txt");
    await handler.push(LOCAL(), "a-dir/deep/b.txt");

    const all = await handler.list();
    const sha = h.blobSha(CONTENT);
    expect(all).toEqual([
      { path: "a-dir/deep/b.txt", size: CONTENT.length, etagOrHash: sha },
      { path: "some/nested/hello.txt", size: CONTENT.length, etagOrHash: sha },
      { path: "zzz.txt", size: CONTENT.length, etagOrHash: sha },
    ]);
    expect((await handler.list("some/")).map((f) => f.path)).toEqual(["some/nested/hello.txt"]);
    expect(await handler.list("nope/")).toEqual([]);

    const restored = join(workDir, "restored", "hello-copy.bin");
    await handler.pull(KEY, restored);
    expect(await readFile(restored)).toEqual(CONTENT);

    await handler.delete(KEY);
    expect((await handler.list()).map((f) => f.path)).toEqual(["a-dir/deep/b.txt", "zzz.txt"]);
    expect(h.state.commits.at(-1)?.message).toBe(`vsync: delete ${REMOTE}`);
  });

  it("pull falls back to the blobs API for files over 1 MB (contents API returns encoding none)", async () => {
    const big = Buffer.alloc(1_100_000, 7);
    await writeFile(LOCAL(), big);
    const handler = new GithubRepoHandler(CONFIG);
    await handler.push(LOCAL(), KEY);
    const restored = join(workDir, "restored-big", "big.bin");
    await handler.pull(KEY, restored); // contents API alone would throw "Unknown encoding: none"
    expect(await readFile(restored)).toEqual(big);
  });

  it("pull maps a not-found remote to a clear error and leaves no file behind", async () => {
    const dest = join(workDir, "gone", "no.txt");
    await expect(new GithubRepoHandler(CONFIG).pull("missing.txt", dest)).rejects.toThrow(
      "Remote file not found: missing.txt",
    );
    await expect(readFile(dest)).rejects.toThrow();
  });

  it("pull on a path that is a directory fails clearly", async () => {
    await writeFile(LOCAL(), CONTENT);
    const handler = new GithubRepoHandler(CONFIG);
    await handler.push(LOCAL(), KEY);
    await expect(handler.pull("some", join(workDir, "dir.txt"))).rejects.toThrow(
      "Remote path is not a file: some",
    );
  });

  it("delete on a missing remote is a clear error (not idempotent)", async () => {
    await expect(new GithubRepoHandler(CONFIG).delete("missing.txt")).rejects.toThrow(
      "Remote file not found: missing.txt",
    );
  });

  it("list on a never-pushed base path is empty, like a fresh backend", async () => {
    await expect(new GithubRepoHandler(CONFIG).list()).resolves.toEqual([]);
  });

  it("list never fetches outside its own subtree (scoped walk)", async () => {
    await writeFile(LOCAL(), CONTENT);
    const handler = new GithubRepoHandler(CONFIG);
    await handler.push(LOCAL(), KEY);
    h.state.files.set("README.md", Buffer.from("not ours"));
    // the walk starts at the base path only; README lives at the repo root
    expect((await handler.list()).map((f) => f.path)).toEqual(["some/nested/hello.txt"]);
  });

  it("testConnection is ok on the default branch when no branch is configured", async () => {
    await expect(new GithubRepoHandler(ROOT_CONFIG).testConnection()).resolves.toEqual({
      ok: true,
      message: `connected to ${OWNER}/${REPO} (branch 'main')`,
    });
  });

  it("testConnection accepts an empty repo: default branch appears on first push", async () => {
    h.state.repoSize = 0;
    h.state.branches.clear(); // no commits yet — GitHub still reports main as default
    await expect(new GithubRepoHandler(ROOT_CONFIG).testConnection()).resolves.toEqual({
      ok: true,
      message: `connected to ${OWNER}/${REPO} (empty repo — first push creates branch 'main')`,
    });
  });

  it("testConnection still rejects a missing branch on a non-empty repo", async () => {
    h.state.repoSize = 100;
    h.state.branches.clear();
    const result = await new GithubRepoHandler(ROOT_CONFIG).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/branch 'main' not found/);
  });

  it("testConnection reports the configured branch", async () => {
    await expect(new GithubRepoHandler(CONFIG).testConnection()).resolves.toMatchObject({
      ok: true,
      message: `connected to ${OWNER}/${REPO} (branch 'vsync')`,
    });
  });

  it("testConnection fails when the repo is missing or the token can't see it", async () => {
    h.state.repoStatus = 404; // GitHub 404s private repos the token lacks access to
    const result = await new GithubRepoHandler(ROOT_CONFIG).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found or token lacks access/);
  });

  it("testConnection fails on a bad token (401)", async () => {
    h.state.repoStatus = 401;
    const result = await new GithubRepoHandler(ROOT_CONFIG).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found or token lacks access/);
  });

  it("testConnection fails when the configured branch doesn't exist", async () => {
    const result = await new GithubRepoHandler({
      ...ROOT_CONFIG,
      branch: "feature-x",
    }).testConnection();
    expect(result).toEqual({
      ok: false,
      message: `branch 'feature-x' not found on ${OWNER}/${REPO}`,
    });
  });

  it("testConnection never throws on a transport failure", async () => {
    h.state.repoError = new Error("connect ETIMEDOUT api.github.com:443");
    const result = await new GithubRepoHandler(ROOT_CONFIG).testConnection();
    expect(result).toEqual({
      ok: false,
      message: `cannot access ${OWNER}/${REPO}: connect ETIMEDOUT api.github.com:443`,
    });
  });

  it("satisfies the StorageBackend contract structurally", () => {
    const backend: StorageBackend = new GithubRepoHandler(CONFIG);
    for (const method of ["push", "pull", "list", "delete", "testConnection"] as const) {
      expect(typeof backend[method]).toBe("function");
    }
  });
});

describe("nativeVersioning capability flag", () => {
  it("is true on github-repo — directly and through the registry", () => {
    expect(new GithubRepoHandler(CONFIG).capabilities?.nativeVersioning).toBe(true);
    expect(
      createBackend("github-repo", { owner: "o", repo: "r", token: "t" }).capabilities
        ?.nativeVersioning,
    ).toBe(true);
  });

  it("is undefined on every other handler", () => {
    const MINIMAL: Record<string, BackendConfig> = {
      "local-fs": { basePath: workDir },
      s3: { region: "us-east-1", bucket: "b", accessKeyId: "a", secretAccessKey: "s" },
      sftp: { host: "h", username: "u", password: "p", remoteBasePath: "/upload" },
      webdav: { url: "http://w/dav", remoteBasePath: "/vsync" },
    };
    for (const name of Object.keys(MINIMAL)) {
      const backend = createBackend(name, MINIMAL[name]);
      expect(backend.capabilities?.nativeVersioning, name).toBeUndefined();
    }
  });
});
