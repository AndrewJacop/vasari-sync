import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SftpHandler } from "../../../src/storage/handlers/sftp.js";
import type { SftpConfig } from "../../../src/storage/handlers/sftp.js";

/**
 * LIVE suite — skipped unless VSYNC_SFTP_LIVE=1. Runs the full
 * push/pull/list/delete/testConnection flow against a real SFTP server
 * (defaults match a local Docker container; all fields overridable):
 *
 *   docker run -d -p 2222:22 atmoz/sftp foo:pass:1001:100:upload
 *   VSYNC_SFTP_LIVE=1 npx vitest run tests/unit/storage/sftp-live.test.ts
 *
 * Note the 5th user field ("upload") — atmoz/sftp chroots users to a
 * root-owned home, so a writable subdirectory must be declared up front
 * and used as remoteBasePath.
 */
const LIVE = process.env.VSYNC_SFTP_LIVE === "1";
const CONFIG: SftpConfig = {
  host: process.env.VSYNC_SFTP_HOST ?? "localhost",
  port: Number(process.env.VSYNC_SFTP_PORT ?? 2222),
  username: process.env.VSYNC_SFTP_USER ?? "foo",
  password: process.env.VSYNC_SFTP_PASS ?? "pass",
  remoteBasePath: process.env.VSYNC_SFTP_BASE ?? "upload",
};

const KEY = "nested/deep/hello.txt";
const CONTENT = "live check: top secret contents\n";

let workDir: string;
let handler: SftpHandler;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "vsync-sftp-live-"));
  handler = new SftpHandler(CONFIG);
});

afterAll(async () => {
  await handler.close();
  await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("sftp handler against a live server", () => {
  it("testConnection reports the base path", async () => {
    const result = await handler.testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/connected to/);
  });

  it("push creates nested remote dirs and uploads", async () => {
    await writeFile(join(workDir, "hello.txt"), CONTENT, "utf8");
    await handler.push(join(workDir, "hello.txt"), KEY);
    await handler.push(join(workDir, "hello.txt"), "zzz.txt");
  });

  it("list shows both files, sorted, with ISO mtime and size", async () => {
    const files = await handler.list();
    expect(files.map((f) => f.path)).toEqual([KEY, "zzz.txt"]);
    expect(files[0].size).toBe(Buffer.byteLength(CONTENT));
    expect(files[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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

  it("pull of a missing key fails clearly", async () => {
    await expect(handler.pull("missing.txt", join(workDir, "no.txt"))).rejects.toThrow(
      "Remote file not found: missing.txt",
    );
  });

  it("delete removes the file; deleting again fails clearly", async () => {
    await handler.delete(KEY);
    expect((await handler.list()).map((f) => f.path)).toEqual(["zzz.txt"]);
    await expect(handler.delete(KEY)).rejects.toThrow(/Remote file not found/);
  });

  it("list on a missing base path is empty (fresh-backend semantics)", async () => {
    const fresh = new SftpHandler({ ...CONFIG, remoteBasePath: "never-created-dir" });
    try {
      await expect(fresh.list()).resolves.toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});
