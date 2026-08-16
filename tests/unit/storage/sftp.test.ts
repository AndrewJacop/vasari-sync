import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SftpHandler } from "../../../src/storage/handlers/sftp.js";
import type { SftpConfig } from "../../../src/storage/handlers/sftp.js";
import type { StorageBackend } from "../../../src/storage/types.js";

/**
 * All SSH traffic is faked via vi.mock("ssh2-sftp-client") — no network,
 * no credentials. The fake mimics real SFTP server semantics closely
 * enough to catch handler bugs: put into a missing directory fails,
 * list/delete/get of a missing path reject with a not-found code,
 * recursive mkdir is idempotent, exists() returns false|"d"|"-".
 * A live run against a Docker atmoz/sftp server is a separate,
 * opt-in suite (see sftp-live.test.ts).
 */

// In-memory "server". Paths are absolute posix. "/" always exists.
const h = vi.hoisted(() => {
  const state = {
    files: new Map<string, Buffer>(),
    dirs: new Set<string>(["/"]),
    connectCalls: 0,
    connectOptions: null as unknown,
    connectError: null as string | null,
    ended: 0,
  };
  const err = (message: string, code: unknown) => Object.assign(new Error(message), { code });
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

  class FakeSftp {
    async connect(options: unknown): Promise<unknown> {
      if (state.connectError) throw err(`connect: ${state.connectError}`, "ECONNREFUSED");
      state.connectCalls++;
      state.connectOptions = options;
      return {};
    }
    async mkdir(p: string): Promise<string> {
      // recursive: creates every missing ancestor, idempotent
      let cur = "";
      for (const seg of p.split("/").filter(Boolean)) {
        cur += `/${seg}`;
        state.dirs.add(cur);
      }
      return `${p} created`;
    }
    async put(local: string, remote: string): Promise<string> {
      if (!state.dirs.has(parent(remote))) throw err(`put: no such file ${remote}`, 2);
      // dynamic import keeps the hoisted factory free of outer bindings
      const { readFile: rf } = await import("node:fs/promises");
      state.files.set(remote, await rf(local));
      return `uploaded to ${remote}`;
    }
    async get(remote: string, local: string): Promise<string> {
      const buf = state.files.get(remote);
      if (!buf) throw err(`get: no such file ${remote}`, 2);
      const { mkdir: md, writeFile: wf } = await import("node:fs/promises");
      await md(await import("node:path").then((p) => p.dirname(local)), { recursive: true });
      await wf(local, buf);
      return `downloaded ${remote}`;
    }
    async list(dir: string): Promise<unknown[]> {
      if (!state.dirs.has(dir)) throw err(`list: no such directory ${dir}`, 2);
      const names = new Set<string>();
      for (const key of state.files.keys()) {
        if (parent(key) === dir) names.add(key.slice(key.lastIndexOf("/") + 1));
      }
      for (const d of state.dirs) {
        if (d !== "/" && parent(d) === dir) names.add(d.slice(d.lastIndexOf("/") + 1));
      }
      // modifyTime in milliseconds, like ssh2-sftp-client v12 does
      return [...names].map((name) => {
        const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
        return state.files.has(full)
          ? { type: "-", name, size: state.files.get(full)!.length, modifyTime: 1700000000000 }
          : { type: "d", name, size: 96, modifyTime: 1700000000000 };
      });
    }
    async delete(remote: string): Promise<string> {
      if (!state.files.has(remote)) throw err(`delete: no such file ${remote}`, 2);
      state.files.delete(remote);
      return `deleted ${remote}`;
    }
    async exists(p: string): Promise<false | "d" | "-"> {
      if (state.dirs.has(p)) return "d";
      if (state.files.has(p)) return "-";
      return false;
    }
    async end(): Promise<boolean> {
      state.ended++;
      return true;
    }
  }
  return { state, FakeSftp, err };
});

vi.mock("ssh2-sftp-client", () => ({ default: h.FakeSftp }));

const BASE = "/home/user/vsync";
const CONFIG: SftpConfig = {
  host: "sftp.example.com",
  port: 2222,
  username: "user",
  password: "secret",
  remoteBasePath: BASE,
};

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "vsync-sftp-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.state.files.clear();
  h.state.dirs.clear();
  h.state.dirs.add("/");
  h.state.connectCalls = 0;
  h.state.connectOptions = null;
  h.state.connectError = null;
  h.state.ended = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const KEY = "some/nested/hello.txt";
const REMOTE = `${BASE}/${KEY}`;
const CONTENT = "top secret contents\n"; // 20 bytes
const LOCAL = () => join(workDir, "hello.txt");

describe("sftp handler config validation", () => {
  it("throws a clear error listing every missing required setting", () => {
    expect(() => new SftpHandler({} as unknown as SftpConfig)).toThrow(
      /sftp backend missing required settings: host, username, remoteBasePath/,
    );
  });

  it("requires password or privateKeyPath", () => {
    const config = { host: "h", username: "u", remoteBasePath: "/x" } as SftpConfig;
    expect(() => new SftpHandler(config)).toThrow(/password.*privateKeyPath/);
  });
});

describe("sftp handler (faked ssh2-sftp-client)", () => {
  it("push connects once, creates base dirs, uploads with a posix remote path", async () => {
    await writeFile(LOCAL(), CONTENT, "utf8");
    await new SftpHandler(CONFIG).push(LOCAL(), KEY);
    expect(h.state.files.get(REMOTE)?.toString()).toBe(CONTENT);
    expect(h.state.dirs).toContain(`${BASE}/some/nested`);
    expect(h.state.connectCalls).toBe(1);
    expect(h.state.connectOptions).toMatchObject({
      host: "sftp.example.com",
      port: 2222,
      username: "user",
      password: "secret",
    });
  });

  it("defaults the port to 22 and reads the private key from disk", async () => {
    const keyPath = join(workDir, "id_rsa");
    await writeFile(keyPath, "FAKE-KEY-BODY", "utf8");
    const handler = new SftpHandler({
      host: "h",
      username: "u",
      privateKeyPath: keyPath,
      remoteBasePath: BASE,
    });
    await handler.testConnection();
    expect(h.state.connectOptions).toMatchObject({ host: "h", port: 22, username: "u" });
    expect((h.state.connectOptions as { privateKey: Buffer }).privateKey.toString()).toBe(
      "FAKE-KEY-BODY",
    );
    // password must NOT be sent in key mode
    expect(h.state.connectOptions).not.toHaveProperty("password");
  });

  it("fails clearly when the private key file is unreadable", async () => {
    const handler = new SftpHandler({
      host: "h",
      username: "u",
      privateKeyPath: join(workDir, "no-such-key"),
      remoteBasePath: BASE,
    });
    await expect(handler.list()).rejects.toThrow(/cannot read privateKeyPath/);
  });

  it("reuses one connection across operations; close() ends it and the next op reconnects", async () => {
    await writeFile(LOCAL(), CONTENT, "utf8");
    const handler = new SftpHandler(CONFIG);
    await handler.push(LOCAL(), KEY);
    await handler.list();
    await handler.pull(KEY, join(workDir, "copy.txt"));
    await handler.delete(KEY);
    expect(h.state.connectCalls).toBe(1);
    expect(h.state.ended).toBe(0);
    await handler.close();
    expect(h.state.ended).toBe(1);
    await handler.list();
    expect(h.state.connectCalls).toBe(2);
    await handler.close();
  });

  it("push → list → pull → delete round-trip: sorted, prefix-filtered, ISO mtime, no etag", async () => {
    await writeFile(LOCAL(), CONTENT, "utf8");
    const handler = new SftpHandler(CONFIG);
    await handler.push(LOCAL(), KEY);
    await handler.push(LOCAL(), "zzz.txt");
    await handler.push(LOCAL(), "a-dir/deep/b.txt");

    const all = await handler.list();
    expect(all).toEqual([
      // sorted by key
      { path: "a-dir/deep/b.txt", size: CONTENT.length, modifiedAt: "2023-11-14T22:13:20.000Z" },
      {
        path: "some/nested/hello.txt",
        size: CONTENT.length,
        modifiedAt: "2023-11-14T22:13:20.000Z",
      },
      { path: "zzz.txt", size: CONTENT.length, modifiedAt: "2023-11-14T22:13:20.000Z" },
    ]);
    expect(all[0]).not.toHaveProperty("etagOrHash"); // SFTP has no etag

    expect((await handler.list("some/")).map((f) => f.path)).toEqual(["some/nested/hello.txt"]);
    expect(await handler.list("nope/")).toEqual([]);

    const restored = join(workDir, "restored", "hello-copy.txt");
    await handler.pull(KEY, restored);
    await expect(readFile(restored, "utf8")).resolves.toBe(CONTENT);

    await handler.delete(KEY);
    expect((await handler.list()).map((f) => f.path)).toEqual(["a-dir/deep/b.txt", "zzz.txt"]);
  });

  it("pull maps a not-found remote to a clear error", async () => {
    await expect(
      new SftpHandler(CONFIG).pull("missing.txt", join(workDir, "gone.txt")),
    ).rejects.toThrow("Remote file not found: missing.txt");
  });

  it("delete maps a not-found remote to a clear error (SFTP delete is not idempotent)", async () => {
    await expect(new SftpHandler(CONFIG).delete("missing.txt")).rejects.toThrow(
      "Remote file not found: missing.txt",
    );
  });

  it("list on a never-created base path is empty, like a fresh backend", async () => {
    await expect(new SftpHandler(CONFIG).list()).resolves.toEqual([]);
    expect(h.state.connectCalls).toBe(1); // connected fine; base just absent
  });

  it("testConnection is ok when the base path exists", async () => {
    h.state.dirs.add(BASE);
    await expect(new SftpHandler(CONFIG).testConnection()).resolves.toEqual({
      ok: true,
      message: "connected to sftp.example.com:2222 as user",
    });
  });

  it("testConnection is ok (with a note) when the base path will be created on first push", async () => {
    const result = await new SftpHandler(CONFIG).testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/will be created on first push/);
  });

  it("testConnection fails when the base path exists but is a file", async () => {
    h.state.files.set(BASE, Buffer.from("occupier"));
    const result = await new SftpHandler(CONFIG).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a directory/);
  });

  it("testConnection never throws on connection failure", async () => {
    h.state.connectError = "connection refused";
    const result = await new SftpHandler(CONFIG).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot connect to sftp\.example\.com:2222 as user/);
  });

  it("push/pull/list/delete satisfy the StorageBackend contract structurally", () => {
    const backend: StorageBackend = new SftpHandler(CONFIG);
    for (const method of ["push", "pull", "list", "delete", "testConnection"] as const) {
      expect(typeof backend[method]).toBe("function");
    }
  });
});
