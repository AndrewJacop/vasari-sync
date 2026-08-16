import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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

function entry(path: string): ManifestFileEntry {
  return { path };
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
    upsertFileEntry(m, entry(".env"));
    upsertFileEntry(m, entry("config/local.json"));
    await writeManifest(root, m);

    const back = await readManifest(root);
    expect(back).toEqual(m);

    const raw = await readFile(manifestPath(root), "utf8");
    expect(raw).toContain('"projectId": "test-project"');
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("strips legacy hash/size/mtime fields from pre-sidecar manifests on read", async () => {
    // Old-model manifests carried per-file hash bookkeeping; the new model
    // keeps all remote state in the backend index. Reading one must not
    // resurrect the stale fields (and the next write drops them).
    await writeFile(
      manifestPath(root),
      JSON.stringify({
        projectId: "legacy",
        backend: "local-fs",
        files: [
          {
            path: ".env",
            hash: "sha256:old",
            size: 12,
            mtimeLocal: "2026-08-15T10:22:00Z",
            lastSyncedHash: "sha256:old",
            lastSyncedAt: "2026-08-15T10:22:00Z",
          },
        ],
      }),
      "utf8",
    );

    const back = await readManifest(root);
    expect(back!.files).toEqual([{ path: ".env" }]);

    await writeManifest(root, back!);
    const raw = await readFile(manifestPath(root), "utf8");
    expect(raw).not.toContain("sha256");
    expect(raw).not.toContain("lastSynced");
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
    upsertFileEntry(m, entry(".env"));
    expect(m.files).toHaveLength(1);
    expect(m.files[0].path).toBe(".env");
  });

  it("never duplicates an existing path", () => {
    const m = freshManifest();
    upsertFileEntry(m, entry(".env"));
    upsertFileEntry(m, entry(".env"));
    expect(m.files).toHaveLength(1);
  });

  it("keeps entries sorted by path regardless of insert order", () => {
    const m = freshManifest();
    upsertFileEntry(m, entry("z-last.txt"));
    upsertFileEntry(m, entry(".env"));
    upsertFileEntry(m, entry("m-mid.json"));
    expect(m.files.map((f) => f.path)).toEqual([".env", "m-mid.json", "z-last.txt"]);
  });

  it("removes an existing entry and reports true", () => {
    const m = freshManifest();
    upsertFileEntry(m, entry(".env"));
    expect(removeFileEntry(m, ".env")).toBe(true);
    expect(m.files).toHaveLength(0);
  });

  it("reports false when removing an untracked path", () => {
    const m = freshManifest();
    expect(removeFileEntry(m, "nope.txt")).toBe(false);
  });
});
