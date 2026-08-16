import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFile } from "../../../src/core/hash.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vsync-hash-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("hashFile", () => {
  it("hashes known content (hello world vector)", async () => {
    const f = join(dir, "hello.txt");
    await writeFile(f, "hello world", "utf8");
    await expect(hashFile(f)).resolves.toBe(
      "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("hashes an empty file", async () => {
    const f = join(dir, "empty.txt");
    await writeFile(f, "", "utf8");
    await expect(hashFile(f)).resolves.toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("streams a multi-megabyte file identically to a one-shot hash", async () => {
    const f = join(dir, "big.bin");
    const buf = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + (i >> 13)) & 0xff;
    await writeFile(f, buf);
    // 5 MB far exceeds the default 64KB read chunk, so this exercises multi-chunk streaming.
    await expect(hashFile(f)).resolves.toBe(
      `sha256:${createHash("sha256").update(buf).digest("hex")}`,
    );
  });

  it("rejects for a missing file", async () => {
    await expect(hashFile(join(dir, "nope.txt"))).rejects.toThrow();
  });
});
