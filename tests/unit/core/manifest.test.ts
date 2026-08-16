import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectConflict,
  manifestPath,
  readManifest,
  removeFileEntry,
  upsertFileEntry,
  writeManifest,
  type Manifest,
  type ManifestFileEntry,
} from "../../../src/core/manifest.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vsync-manifest-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function entry(
  path: string,
  hash: string,
  overrides: Partial<ManifestFileEntry> = {},
): ManifestFileEntry {
  return {
    path,
    hash,
    size: 100,
    mtimeLocal: "2026-08-15T10:22:00Z",
    ...overrides,
  };
}

function freshManifest(): Manifest {
  return { projectId: "test-project", backend: "local-fs", files: [] };
}

describe("readManifest / writeManifest", () => {
  it("returns null for a project with no manifest yet (no throw)", async () => {
    await expect(readManifest(root)).resolves.toBeNull();
  });

  it("round-trips a manifest through disk, creating .vsync/", async () => {
    const m = freshManifest();
    upsertFileEntry(m, entry(".env", "sha256:aaa"));
    upsertFileEntry(m, entry("config/local.json", "sha256:bbb"));
    await writeManifest(root, m);

    const back = await readManifest(root);
    expect(back).toEqual(m);

    const raw = await readFile(manifestPath(root), "utf8");
    expect(raw).toContain('"projectId": "test-project"');
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("overwrites cleanly on re-write", async () => {
    const m = freshManifest();
    await writeManifest(root, m);
    await expect(readManifest(root)).resolves.toEqual(m);
  });

  it("fails loudly on a corrupt manifest instead of resetting tracking", async () => {
    await writeFile(manifestPath(root), "{ not json", "utf8");
    await expect(readManifest(root)).rejects.toThrow(/Corrupt manifest/);
  });
});

describe("upsertFileEntry / removeFileEntry", () => {
  it("adds a new entry", () => {
    const m = freshManifest();
    upsertFileEntry(m, entry(".env", "sha256:1"));
    expect(m.files).toHaveLength(1);
    expect(m.files[0].path).toBe(".env");
  });

  it("replaces an existing entry by path instead of duplicating", () => {
    const m = freshManifest();
    upsertFileEntry(m, entry(".env", "sha256:1"));
    upsertFileEntry(m, entry(".env", "sha256:2", { size: 250 }));
    expect(m.files).toHaveLength(1);
    expect(m.files[0].hash).toBe("sha256:2");
    expect(m.files[0].size).toBe(250);
  });

  it("keeps entries sorted by path regardless of insert order", () => {
    const m = freshManifest();
    upsertFileEntry(m, entry("z-last.txt", "sha256:1"));
    upsertFileEntry(m, entry(".env", "sha256:2"));
    upsertFileEntry(m, entry("m-mid.json", "sha256:3"));
    expect(m.files.map((f) => f.path)).toEqual([".env", "m-mid.json", "z-last.txt"]);
  });

  it("removes an existing entry and reports true", () => {
    const m = freshManifest();
    upsertFileEntry(m, entry(".env", "sha256:1"));
    expect(removeFileEntry(m, ".env")).toBe(true);
    expect(m.files).toHaveLength(0);
  });

  it("reports false when removing an untracked path", () => {
    const m = freshManifest();
    expect(removeFileEntry(m, "nope.txt")).toBe(false);
  });
});

describe("detectConflict", () => {
  const synced = entry(".env", "sha256:synced", {
    lastSyncedHash: "sha256:synced",
    lastSyncedAt: "2026-08-15T10:22:00Z",
  });

  it("unchanged when local and remote both match last synced", () => {
    expect(detectConflict(synced, "sha256:synced")).toBe("unchanged");
  });

  it("local-modified when only the local hash moved", () => {
    expect(detectConflict({ ...synced, hash: "sha256:newer" }, "sha256:synced")).toBe(
      "local-modified",
    );
  });

  it("remote-modified when only the remote hash moved", () => {
    expect(detectConflict(synced, "sha256:remote-newer")).toBe("remote-modified");
  });

  it("conflict when both sides changed independently", () => {
    expect(detectConflict({ ...synced, hash: "sha256:newer" }, "sha256:remote-newer")).toBe(
      "conflict",
    );
  });

  it("remote-missing when the backend has no copy", () => {
    expect(detectConflict(synced, undefined)).toBe("remote-missing");
  });

  it("never-synced entry with a remote copy present is a conflict (both sides differ)", () => {
    const never = entry(".env", "sha256:fresh");
    expect(detectConflict(never, "sha256:whatever-is-remote")).toBe("conflict");
  });
});
