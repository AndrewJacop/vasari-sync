import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAddCommand } from "../../src/commands/add.js";
import { runRmCommand } from "../../src/commands/rm.js";
import { hashFile } from "../../src/core/hash.js";
import { readManifest, writeManifest, type ManifestFileEntry } from "../../src/core/manifest.js";

const execFileAsync = promisify(execFile);

let projectRoot: string | undefined;

/** Real git project, initialized the way `vsync init` leaves it (manifest +
 * project config written directly — init's own flow is covered by
 * init.test.ts; add/rm never touch the backend or global config). */
async function makeProject(name: string, tracked: string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `vsync-addrm-${name}-`));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, ".gitignore"), ".env*\nlocal-notes.txt\n");
  await writeFile(join(root, ".env"), "A=1\nB=2\n");
  await writeFile(join(root, "local-notes.txt"), "just some notes\n");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "app.local.json"), '{ "debug": true }\n');

  const files: ManifestFileEntry[] = [];
  for (const rel of tracked) {
    const abs = join(root, rel);
    const info = await stat(abs);
    files.push({
      path: rel,
      hash: await hashFile(abs),
      size: info.size,
      mtimeLocal: info.mtime.toISOString(),
    });
  }
  await writeManifest(root, { projectId: name, backend: "local-fs", files });
  return root;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe("vsync add", () => {
  it("adds a new file to the manifest without syncing it", async () => {
    projectRoot = await makeProject("add-new");
    await runAddCommand(projectRoot, ["local-notes.txt"]);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files).toHaveLength(1);
    const entry = manifest!.files[0];
    expect(entry.path).toBe("local-notes.txt");
    expect(entry.hash).toBe(await hashFile(join(projectRoot, "local-notes.txt")));
    expect(entry.size).toBe(16);
    expect(entry.mtimeLocal).toBeTypeOf("string");
    // add never syncs — no lastSynced fields until push/pull runs.
    expect(entry.lastSyncedHash).toBeUndefined();
    expect(entry.lastSyncedAt).toBeUndefined();

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Added 1 file(s) to tracking: local-notes.txt"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Nothing was uploaded — run `vsync push`"),
    );
  });

  it("adds several files at once, normalizing paths to project-relative posix", async () => {
    projectRoot = await makeProject("add-multi");
    await runAddCommand(projectRoot, [".env", "./sub/app.local.json"]);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files.map((f) => f.path)).toEqual([".env", "sub/app.local.json"]);
  });

  it("rejects a missing file and adds nothing", async () => {
    projectRoot = await makeProject("add-missing", ["local-notes.txt"]);
    const before = await readFile(join(projectRoot, ".vsync", "manifest.json"), "utf8");

    await expect(runAddCommand(projectRoot, ["nope.txt"])).rejects.toThrow(
      /'nope\.txt' does not exist.*Nothing was added/,
    );
    expect(await readFile(join(projectRoot, ".vsync", "manifest.json"), "utf8")).toBe(before);
  });

  it("rejects an already-tracked file instead of duplicating it", async () => {
    projectRoot = await makeProject("add-dup", ["local-notes.txt"]);

    await expect(runAddCommand(projectRoot, ["local-notes.txt"])).rejects.toThrow(
      /'local-notes\.txt' is already tracked/,
    );

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files.filter((f) => f.path === "local-notes.txt")).toHaveLength(1);
  });

  it("is all-or-nothing: one bad path in a batch adds nothing", async () => {
    projectRoot = await makeProject("add-batch");
    await expect(runAddCommand(projectRoot, [".env", "missing.txt"])).rejects.toThrow(
      /'missing\.txt' does not exist/,
    );
    const manifest = await readManifest(projectRoot);
    expect(manifest!.files).toEqual([]); // '.env' was NOT silently added
  });

  it("rejects paths outside the project root", async () => {
    projectRoot = await makeProject("add-escape");
    await expect(runAddCommand(projectRoot, ["../outside.txt"])).rejects.toThrow(
      /outside the project root/,
    );
  });

  it("requires an initialized project", async () => {
    const bare = await mkdtemp(join(tmpdir(), "vsync-addrm-bare-"));
    try {
      await expect(runAddCommand(bare, [".env"])).rejects.toThrow(/`vsync init`/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("vsync rm", () => {
  it("removes a tracked file from the manifest but leaves the local file untouched", async () => {
    projectRoot = await makeProject("rm-ok", ["local-notes.txt", ".env"]);
    const contentBefore = await readFile(join(projectRoot, "local-notes.txt"), "utf8");

    await runRmCommand(projectRoot, ["local-notes.txt"]);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files.map((f) => f.path)).toEqual([".env"]);
    // Local file still there, same bytes.
    expect(await readFile(join(projectRoot, "local-notes.txt"), "utf8")).toBe(contentBefore);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Removed 1 file(s) from tracking: local-notes.txt"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Local files were NOT deleted"),
    );
  });

  it("removes several files at once", async () => {
    projectRoot = await makeProject("rm-multi", [".env", "local-notes.txt", "sub/app.local.json"]);
    await runRmCommand(projectRoot, ["local-notes.txt", "sub/app.local.json"]);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files.map((f) => f.path)).toEqual([".env"]);
    expect(await readFile(join(projectRoot, "local-notes.txt"), "utf8")).toContain("notes");
  });

  it("rejects an untracked path and removes nothing", async () => {
    projectRoot = await makeProject("rm-untracked", [".env"]);
    const before = JSON.stringify(await readManifest(projectRoot));

    await expect(runRmCommand(projectRoot, ["never-tracked.txt"])).rejects.toThrow(
      /Not tracked: 'never-tracked\.txt'.*Nothing was removed/,
    );
    expect(JSON.stringify(await readManifest(projectRoot))).toBe(before);
  });

  it("is all-or-nothing: mixed tracked/untracked removes nothing", async () => {
    projectRoot = await makeProject("rm-batch", [".env", "local-notes.txt"]);
    await expect(runRmCommand(projectRoot, [".env", "not-tracked.txt"])).rejects.toThrow(
      /Not tracked: 'not-tracked\.txt'/,
    );
    const manifest = await readManifest(projectRoot);
    expect(manifest!.files.map((f) => f.path)).toEqual([".env", "local-notes.txt"]);
  });

  it("requires an initialized project", async () => {
    const bare = await mkdtemp(join(tmpdir(), "vsync-addrm-bare2-"));
    try {
      await expect(runRmCommand(bare, [".env"])).rejects.toThrow(/`vsync init`/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("vsync add/rm --json", () => {
  it("add emits {added: [...]}", async () => {
    projectRoot = await makeProject("json-add", [".env"]);

    await runAddCommand(projectRoot, ["local-notes.txt", "sub/app.local.json"], true);

    const raw = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .find((l) => l.trim().startsWith("{"));
    expect(JSON.parse(raw as string)).toEqual({
      added: ["local-notes.txt", "sub/app.local.json"],
    });
  });

  it("rm emits {removed: [...]}", async () => {
    projectRoot = await makeProject("json-rm", [".env", "local-notes.txt"]);

    await runRmCommand(projectRoot, [".env"], true);

    const raw = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .find((l) => l.trim().startsWith("{"));
    expect(JSON.parse(raw as string)).toEqual({ removed: [".env"] });
  });
});
