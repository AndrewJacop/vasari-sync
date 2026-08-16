import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDavHandler } from "../../../src/storage/handlers/webdav.js";
import type { WebDavConfig } from "../../../src/storage/handlers/webdav.js";

/**
 * LIVE suite — skipped unless VSYNC_WEBDAV_LIVE=1. Runs the full
 * push/pull/list/delete/testConnection flow against a real WebDAV server
 * (defaults match a local Docker container; all fields overridable):
 *
 *   docker run -d -p 8888:80 -e AUTH_TYPE=Basic -e USERNAME=user \
 *     -e PASSWORD=pass bytemark/webdav
 *   VSYNC_WEBDAV_LIVE=1 npx vitest run tests/unit/storage/webdav-live.test.ts
 *
 * Note this image serves the DAV collection at "/" (not /webdav).
 */
const LIVE = process.env.VSYNC_WEBDAV_LIVE === "1";
const CONFIG: WebDavConfig = {
  url: process.env.VSYNC_WEBDAV_URL ?? "http://localhost:8888",
  username: process.env.VSYNC_WEBDAV_USER ?? "user",
  password: process.env.VSYNC_WEBDAV_PASS ?? "pass",
  remoteBasePath: process.env.VSYNC_WEBDAV_BASE ?? "vsync-test",
};

const KEY = "nested/deep/hello.txt";
const CONTENT = "live check: top secret contents\n";

let workDir: string;
let handler: WebDavHandler;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "vsync-webdav-live-"));
  handler = new WebDavHandler(CONFIG);
});

afterAll(async () => {
  if (LIVE) {
    // leave the container's test collection clean for re-runs
    for (const f of await handler.list()) {
      try {
        await handler.delete(f.path);
      } catch {
        // best-effort cleanup only
      }
    }
  }
  await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("webdav handler against a live server", () => {
  it("testConnection reports the base path", async () => {
    const result = await handler.testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/connected to/);
  });

  it("push creates nested remote collections and uploads", async () => {
    await writeFile(join(workDir, "hello.txt"), CONTENT, "utf8");
    await handler.push(join(workDir, "hello.txt"), KEY);
    await handler.push(join(workDir, "hello.txt"), "zzz.txt");
  });

  it("list shows both files, sorted, with ISO mtime, size, and etag", async () => {
    const files = await handler.list();
    expect(files.map((f) => f.path)).toEqual([KEY, "zzz.txt"]);
    expect(files[0].size).toBe(Buffer.byteLength(CONTENT));
    expect(files[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(files[0].etagOrHash).toBeTruthy(); // Apache always serves etags
  });

  it("list honors a prefix filter", async () => {
    expect((await handler.list("nested/")).map((f) => f.path)).toEqual([KEY]);
    expect(await handler.list("nope/")).toEqual([]);
  });

  it("pull restores the exact content", async () => {
    const dest = join(workDir, "restored", "hello.txt");
    await handler.pull(KEY, dest);
    await expect(readFile(dest, "utf8")).resolves.toBe(CONTENT);
  });

  it("pull of a missing key fails clearly and leaves no local file", async () => {
    const dest = join(workDir, "no.txt");
    await expect(handler.pull("missing.txt", dest)).rejects.toThrow(
      "Remote file not found: missing.txt",
    );
    await expect(readFile(dest)).rejects.toThrow();
  });

  it("delete removes the file; deleting again fails clearly", async () => {
    await handler.delete(KEY);
    expect((await handler.list()).map((f) => f.path)).toEqual(["zzz.txt"]);
    await expect(handler.delete(KEY)).rejects.toThrow(/Remote file not found/);
  });

  it("list on a missing base path is empty (fresh-backend semantics)", async () => {
    const fresh = new WebDavHandler({ ...CONFIG, remoteBasePath: "never-created-dir" });
    await expect(fresh.list()).resolves.toEqual([]);
  });
});
