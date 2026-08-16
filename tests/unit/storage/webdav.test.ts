import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebDavHandler } from "../../../src/storage/handlers/webdav.js";
import type { WebDavConfig } from "../../../src/storage/handlers/webdav.js";
import type { StorageBackend } from "../../../src/storage/types.js";

/**
 * All WebDAV traffic is faked via vi.mock("webdav") — no network, no
 * credentials. The fake mimics real server/client semantics closely enough
 * to catch handler bugs: PROPFIND on a missing directory rejects with
 * .status 404, DELETE on a missing file rejects 404, GET streams (missing
 * file emits "error" on the stream), errors carry .status like
 * webdav-client's own createErrorFromResponse does, etags come back
 * double-quoted, lastmod is an HTTP-date string. A live run against a
 * Docker WebDAV server is a separate, opt-in suite (see webdav-live.test.ts).
 */

// In-memory "server". Paths are absolute posix. "/" always exists.
const h = vi.hoisted(() => {
  const state = {
    files: new Map<string, Buffer>(),
    dirs: new Set<string>(["/"]),
    clients: [] as Array<{ url: string; options: unknown }>,
    statError: null as Error | null,
  };
  // webdav-client maps HTTP >=400 to Errors carrying .status
  const err = (message: string, code: number) => Object.assign(new Error(message), { status: code });
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const LASTMOD = "Tue, 05 Apr 2016 14:39:18 GMT";

  class FakeDav {
    constructor(url: string, options: unknown) {
      state.clients.push({ url, options });
    }
    async createDirectory(p: string): Promise<void> {
      // recursive MKCOL: creates every missing ancestor, skips existing
      let cur = "";
      for (const seg of p.split("/").filter(Boolean)) {
        cur += `/${seg}`;
        state.dirs.add(cur);
      }
    }
    async putFileContents(remote: string, data: NodeJS.ReadableStream): Promise<boolean> {
      if (!state.dirs.has(parent(remote))) throw err(`put: 409 conflict ${remote}`, 409);
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(Buffer.from(chunk as Buffer));
      state.files.set(remote, Buffer.concat(chunks));
      return true;
    }
    createReadStream(remote: string): PassThrough {
      // Real lib returns a PassThrough that emits "error" if the GET fails.
      const out = new PassThrough();
      const buf = state.files.get(remote);
      if (!buf) queueMicrotask(() => out.emit("error", err(`get: 404 ${remote}`, 404)));
      else queueMicrotask(() => out.end(buf));
      return out;
    }
    async getDirectoryContents(dir: string): Promise<unknown[]> {
      if (!state.dirs.has(dir)) throw err(`propfind: 404 ${dir}`, 404);
      const names = new Set<string>();
      for (const key of state.files.keys()) {
        if (parent(key) === dir) names.add(key.slice(key.lastIndexOf("/") + 1));
      }
      for (const d of state.dirs) {
        if (d !== "/" && parent(d) === dir) names.add(d.slice(d.lastIndexOf("/") + 1));
      }
      return [...names].map((name) => {
        const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
        return state.files.has(full)
          ? {
              type: "file",
              basename: name,
              size: state.files.get(full)!.length,
              lastmod: LASTMOD,
              // etags arrive double-quoted from most servers
              etag: `"w-${name.length}"`,
            }
          : { type: "directory", basename: name, size: 0, lastmod: LASTMOD, etag: null };
      });
    }
    async deleteFile(remote: string): Promise<void> {
      if (!state.files.has(remote)) throw err(`delete: 404 ${remote}`, 404);
      state.files.delete(remote);
    }
    async stat(p: string): Promise<unknown> {
      if (state.statError) throw state.statError;
      if (state.dirs.has(p)) return { type: "directory", basename: p };
      if (state.files.has(p)) return { type: "file", basename: p };
      throw err(`stat: 404 ${p}`, 404);
    }
  }
  return { state, FakeDav, err };
});

vi.mock("webdav", () => ({ createClient: (url: string, options: unknown) => new h.FakeDav(url, options) }));

const URL = "http://webdav.example.com/dav";
const BASE = "/vsync";
const CONFIG: WebDavConfig = {
  url: URL,
  username: "user",
  password: "secret",
  remoteBasePath: BASE,
};

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "vsync-webdav-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.state.files.clear();
  h.state.dirs.clear();
  h.state.dirs.add("/");
  h.state.clients.length = 0;
  h.state.statError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const KEY = "some/nested/hello.txt";
const REMOTE = `${BASE}/${KEY}`;
const CONTENT = "top secret contents\n"; // 20 bytes
const LOCAL = () => join(workDir, "hello.txt");

describe("webdav handler config validation", () => {
  it("throws a clear error listing every missing required setting", () => {
    expect(() => new WebDavHandler({} as unknown as WebDavConfig)).toThrow(
      /webdav backend missing required settings: url, remoteBasePath/,
    );
  });
});

describe("webdav handler (faked webdav client)", () => {
  it("push creates parent collections and streams the body with credentials", async () => {
    await writeFile(LOCAL(), CONTENT, "utf8");
    await new WebDavHandler(CONFIG).push(LOCAL(), KEY);
    expect(h.state.files.get(REMOTE)?.toString()).toBe(CONTENT);
    expect(h.state.dirs).toContain(`${BASE}/some/nested`);
    expect(h.state.clients).toHaveLength(1);
    expect(h.state.clients[0]).toMatchObject({ url: URL });
    expect(h.state.clients[0].options).toEqual({ username: "user", password: "secret" });
  });

  it("omits username/password keys entirely for an anonymous server", async () => {
    const handler = new WebDavHandler({ url: URL, remoteBasePath: BASE });
    await handler.testConnection();
    expect(h.state.clients[0].options).toEqual({});
  });

  it("push → list → pull → delete round-trip: sorted, prefix-filtered, bare etag, ISO mtime", async () => {
    await writeFile(LOCAL(), CONTENT, "utf8");
    const handler = new WebDavHandler(CONFIG);
    await handler.push(LOCAL(), KEY);
    await handler.push(LOCAL(), "zzz.txt");
    await handler.push(LOCAL(), "a-dir/deep/b.txt");

    const all = await handler.list();
    expect(all).toEqual([
      // sorted by key; quoted server etag stored bare; HTTP-date → ISO
      { path: "a-dir/deep/b.txt", size: CONTENT.length, etagOrHash: "w-5", modifiedAt: "2016-04-05T14:39:18.000Z" },
      { path: "some/nested/hello.txt", size: CONTENT.length, etagOrHash: "w-9", modifiedAt: "2016-04-05T14:39:18.000Z" },
      { path: "zzz.txt", size: CONTENT.length, etagOrHash: "w-7", modifiedAt: "2016-04-05T14:39:18.000Z" },
    ]);

    expect((await handler.list("some/")).map((f) => f.path)).toEqual(["some/nested/hello.txt"]);
    expect(await handler.list("nope/")).toEqual([]);

    const restored = join(workDir, "restored", "hello-copy.txt");
    await handler.pull(KEY, restored);
    await expect(readFile(restored, "utf8")).resolves.toBe(CONTENT);

    await handler.delete(KEY);
    expect((await handler.list()).map((f) => f.path)).toEqual(["a-dir/deep/b.txt", "zzz.txt"]);
  });

  it("pull maps a not-found remote to a clear error and leaves no truncated file", async () => {
    const dest = join(workDir, "gone", "no.txt");
    await expect(new WebDavHandler(CONFIG).pull("missing.txt", dest)).rejects.toThrow(
      "Remote file not found: missing.txt",
    );
    // the 404 arrives before any body is written, but a failed transfer
    // must never leave a partial file behind
    await expect(readFile(dest)).rejects.toThrow();
  });

  it("delete maps a not-found remote to a clear error (WebDAV delete is not idempotent)", async () => {
    await expect(new WebDavHandler(CONFIG).delete("missing.txt")).rejects.toThrow(
      "Remote file not found: missing.txt",
    );
  });

  it("list on a never-created base path is empty, like a fresh backend", async () => {
    await expect(new WebDavHandler(CONFIG).list()).resolves.toEqual([]);
  });

  it("testConnection is ok when the base path exists", async () => {
    h.state.dirs.add(BASE);
    await expect(new WebDavHandler(CONFIG).testConnection()).resolves.toEqual({
      ok: true,
      message: `connected to ${URL} (base path '${BASE}')`,
    });
  });

  it("testConnection is ok (with a note) when the base path will be created on first push", async () => {
    const result = await new WebDavHandler(CONFIG).testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/will be created on first push/);
  });

  it("testConnection fails when the base path exists but is a file", async () => {
    h.state.files.set(BASE, Buffer.from("occupier"));
    const result = await new WebDavHandler(CONFIG).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a directory/);
  });

  it("testConnection never throws on a transport failure", async () => {
    h.state.statError = new Error("connect ECONNREFUSED 127.0.0.1:80");
    const result = await new WebDavHandler(CONFIG).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot access http:\/\/webdav\.example\.com\/dav/);
  });

  it("push/pull/list/delete satisfy the StorageBackend contract structurally", () => {
    const backend: StorageBackend = new WebDavHandler(CONFIG);
    for (const method of ["push", "pull", "list", "delete", "testConnection"] as const) {
      expect(typeof backend[method]).toBe("function");
    }
    expect(backend.capabilities?.nativeVersioning).toBeUndefined(); // github-repo only
  });
});
