import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFile } from "../../../src/core/hash.js";
import { availableBackends, createBackend } from "../../../src/storage/registry.js";
import type { BackendConfig, StorageBackend } from "../../../src/storage/types.js";

let storageDir: string;
let workDir: string;

/** Minimal valid config per backend, for the structural interface check. */
const MINIMAL_CONFIG: Record<string, BackendConfig> = {
  "local-fs": { basePath: () => storageDir }, // replaced in beforeAll
  s3: { region: "us-east-1", bucket: "test-bucket", accessKeyId: "a", secretAccessKey: "s" },
  sftp: { host: "sftp.example.com", username: "u", password: "p", remoteBasePath: "/upload" },
};

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "vsync-remote-"));
  workDir = await mkdtemp(join(tmpdir(), "vsync-local-"));
  MINIMAL_CONFIG["local-fs"] = { basePath: storageDir };
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe("registry", () => {
  it("resolves every registered backend to an object implementing the full interface", () => {
    for (const name of availableBackends()) {
      const backend = createBackend(name, MINIMAL_CONFIG[name]);
      for (const method of ["push", "pull", "list", "delete", "testConnection"] as const) {
        expect(typeof backend[method], `${name}.${method}`).toBe("function");
      }
    }
  });

  it("throws a clear, actionable error for an unknown backend name", () => {
    expect(() => createBackend("bogus", {})).toThrow(
      `Unknown backend 'bogus', available: ${availableBackends().join(", ")}`,
    );
    // The message must actually name what IS available.
    expect(availableBackends()).toContain("local-fs");
  });

  it("requires basePath for local-fs", () => {
    expect(() => createBackend("local-fs", {})).toThrow(/basePath/);
  });
});

describe("local-fs backend round-trip (push → list → pull → delete)", () => {
  const KEY = "some/nested/hello.txt";
  const CONTENT = "top secret contents\n"; // 20 bytes
  let backend: StorageBackend;

  beforeAll(async () => {
    backend = createBackend("local-fs", { basePath: storageDir });
    await writeFile(join(workDir, "hello.txt"), CONTENT, "utf8");
  });

  it("testConnection succeeds against the existing basePath", async () => {
    await expect(backend.testConnection()).resolves.toMatchObject({ ok: true });
  });

  it("testConnection reports failure for a missing basePath", async () => {
    const broken = createBackend("local-fs", { basePath: join(workDir, "does-not-exist") });
    const result = await broken.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it("list is empty before anything is pushed (and on a missing basePath)", async () => {
    await expect(backend.list()).resolves.toEqual([]);
  });

  it("push stores the file; list reflects its remote state", async () => {
    await backend.push(join(workDir, "hello.txt"), KEY);

    const files = await backend.list();
    expect(files.map((f) => f.path)).toEqual([KEY]);
    const [file] = files;
    expect(file.size).toBe(CONTENT.length);
    expect(file.etagOrHash).toBe(await hashFile(join(workDir, "hello.txt")));
    expect(file.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // local-fs gets no native versioning — that flag is github-repo only.
    expect(backend.capabilities?.nativeVersioning).toBeUndefined();
  });

  it("list honors a prefix filter", async () => {
    await expect(backend.list("some/")).resolves.toHaveLength(1);
    await expect(backend.list("nope/")).resolves.toEqual([]);
  });

  it("pull restores the exact content to a fresh nested location", async () => {
    const restored = join(workDir, "restored", "hello-copy.txt");
    await backend.pull(KEY, restored);
    await expect(readFile(restored, "utf8")).resolves.toBe(CONTENT);
  });

  it("delete removes the remote file; list goes empty; pull/delete then fail clearly", async () => {
    await backend.delete(KEY);
    await expect(backend.list()).resolves.toEqual([]);
    await expect(backend.pull(KEY, join(workDir, "gone.txt"))).rejects.toThrow(
      /Remote file not found: some\/nested\/hello\.txt/,
    );
    await expect(backend.delete(KEY)).rejects.toThrow(/Remote file not found/);
  });
});
