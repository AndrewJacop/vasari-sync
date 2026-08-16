import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scripted prompt queue: every prompt pops the next scripted answer, in the
 * order the command asks them (re-init confirm? → projectId input → backend
 * select → connection-failure confirm? → files checkbox).
 */
const q = vi.hoisted(() => ({ answers: [] as unknown[] }));

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(async () => q.answers.shift()),
  select: vi.fn(async () => q.answers.shift()),
  checkbox: vi.fn(async () => q.answers.shift()),
  confirm: vi.fn(async () => q.answers.shift()),
}));

import { checkbox, input } from "@inquirer/prompts";
import { runInitCommand } from "../../src/commands/init.js";
import { hashFile } from "../../src/core/hash.js";
import { readGlobalConfig, writeGlobalConfig } from "../../src/core/globalConfig.js";
import { readManifest } from "../../src/core/manifest.js";
import { readProjectConfig } from "../../src/core/projectConfig.js";

const execFileAsync = promisify(execFile);

function script(...answers: unknown[]): void {
  q.answers = answers;
}

/** A REAL git repo fixture (per plan): ignored .env (boosted), ignored
 * local-notes.txt (plain), and a suppressed node_modules tree. */
async function makeProject(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `vsync-init-${name}-`));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, ".gitignore"), ".env*\nlocal-notes.txt\nnode_modules/\n");
  await writeFile(join(root, ".env"), "A=1\nB=2\n");
  await writeFile(join(root, "local-notes.txt"), "just some notes");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;");
  return root;
}

let home: string;
let storageDir: string;
let projectRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), "vsync-init-home-"));
  storageDir = await mkdtemp(join(tmpdir(), "vsync-init-remote-"));
  await writeGlobalConfig(
    {
      profiles: { "local-fs": { backend: "local-fs", settings: { basePath: storageDir } } },
      secrets: {},
      projects: [],
      defaultBackend: "local-fs",
    },
    home,
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe("vsync init — first run", () => {
  it("creates manifest, project config, and global registry entry", async () => {
    projectRoot = await makeProject("app");
    script("my-app", "local-fs", [".env"]);

    await runInitCommand(projectRoot, home);

    const manifest = await readManifest(projectRoot);
    expect(manifest).not.toBeNull();
    expect(manifest!.projectId).toBe("my-app");
    expect(manifest!.backend).toBe("local-fs");
    expect(manifest!.files).toHaveLength(1);
    const entry = manifest!.files[0];
    expect(entry.path).toBe(".env");
    expect(entry.hash).toBe(await hashFile(join(projectRoot, ".env")));
    expect(entry.size).toBe(8);
    expect(entry.mtimeLocal).toBeTypeOf("string");
    // Never synced: no lastSyncedHash/lastSyncedAt yet.
    expect(entry.lastSyncedHash).toBeUndefined();
    expect(entry.lastSyncedAt).toBeUndefined();

    expect(await readProjectConfig(projectRoot)).toEqual({
      projectId: "my-app",
      backend: "local-fs",
      settings: { basePath: storageDir },
    });

    const globalConfig = await readGlobalConfig(home);
    expect(globalConfig.projects).toEqual([
      { projectId: "my-app", path: projectRoot, backend: "local-fs", lastSyncedAt: undefined },
    ]);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Connection OK"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Initialized 'my-app'"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("run `vsync push`"));
  });

  it("defaults projectId to the folder name and shows the checkbox with boosted pre-checked", async () => {
    projectRoot = await makeProject("default-id");
    const defaultId = basename(projectRoot);
    script(defaultId, "local-fs", []);

    await runInitCommand(projectRoot, home);

    expect(vi.mocked(input)).toHaveBeenCalledWith(expect.objectContaining({ default: defaultId }));
    expect(vi.mocked(checkbox)).toHaveBeenCalledTimes(1);
    const choices = vi.mocked(checkbox).mock.calls[0][0].choices as Array<{
      value: string;
      checked: boolean;
      name: string;
    }>;
    const env = choices.find((c) => c.value === ".env");
    const notes = choices.find((c) => c.value === "local-notes.txt");
    expect(env?.checked).toBe(true); // boosted → pre-checked
    expect(notes?.checked).toBe(false); // plain → unchecked
    // Boosted sorted to the top, suppressed node_modules never shown.
    expect(choices.map((c) => c.value)).toEqual([".env", "local-notes.txt"]);
  });

  it("only tracks checkbox-selected files, not every candidate", async () => {
    projectRoot = await makeProject("unselected");
    script("unselected-app", "local-fs", ["local-notes.txt"]);

    await runInitCommand(projectRoot, home);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files.map((f) => f.path)).toEqual(["local-notes.txt"]);
  });

  it("handles a project with no ignored files (no checkbox prompt, empty manifest)", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vsync-init-empty-"));
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await writeFile(join(projectRoot, "README.md"), "nothing ignored here");
    script("empty-app", "local-fs");

    await runInitCommand(projectRoot, home);

    expect(vi.mocked(checkbox)).not.toHaveBeenCalled();
    const manifest = await readManifest(projectRoot);
    expect(manifest!.files).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No files tracked yet"));
  });

  it("refuses a backend with no saved profile, pointing at vsync config", async () => {
    projectRoot = await makeProject("noprofile");
    script("noprofile-app", "sftp");

    await expect(runInitCommand(projectRoot, home)).rejects.toThrow(
      /No saved profile for 'sftp'.*`vsync config`/,
    );
    // Nothing was written.
    expect(await readManifest(projectRoot)).toBeNull();
    expect(await readProjectConfig(projectRoot)).toBeNull();
  });
});

describe("vsync init — re-running on an initialized project", () => {
  it("warns and requires confirmation; abort leaves everything untouched", async () => {
    projectRoot = await makeProject("reinit");
    script("reinit-app", "local-fs", [".env"]);
    await runInitCommand(projectRoot, home);

    const manifestBefore = await readFile(join(projectRoot, ".vsync", "manifest.json"), "utf8");
    const configBefore = await readFile(join(projectRoot, ".vsync", "config.json"), "utf8");

    vi.mocked(console.log).mockClear();
    script(false); // "Re-initialize anyway?" → no
    await runInitCommand(projectRoot, home);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("already initialized"));
    expect(console.log).toHaveBeenCalledWith("Aborted — nothing changed.");
    expect(await readFile(join(projectRoot, ".vsync", "manifest.json"), "utf8")).toBe(
      manifestBefore,
    );
    expect(await readFile(join(projectRoot, ".vsync", "config.json"), "utf8")).toBe(configBefore);
    const globalConfig = await readGlobalConfig(home);
    expect(globalConfig.projects).toHaveLength(1); // no duplicate entry either
  });

  it("overwrites when the user confirms", async () => {
    projectRoot = await makeProject("overwrite");
    script("overwrite-app", "local-fs", [".env", "local-notes.txt"]);
    await runInitCommand(projectRoot, home);

    script(true, "overwrite-app", "local-fs", []); // re-init, deselect everything
    await runInitCommand(projectRoot, home);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files).toEqual([]);
    expect(await readProjectConfig(projectRoot)).toMatchObject({ projectId: "overwrite-app" });
    const globalConfig = await readGlobalConfig(home);
    expect(globalConfig.projects).toHaveLength(1);
  });
});
