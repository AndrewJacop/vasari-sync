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
  confirm: vi.fn(async () => q.answers.shift()),
}));

vi.mock("../../src/utils/treeCheckbox.js", () => ({
  treeCheckbox: vi.fn(async () => q.answers.shift()),
}));

import { input, select } from "@inquirer/prompts";
import { runInitCommand } from "../../src/commands/init.js";
import { treeCheckbox } from "../../src/utils/treeCheckbox.js";
import { hashFile } from "../../src/core/hash.js";
import { readGlobalConfig, writeGlobalConfig } from "../../src/core/globalConfig.js";
import { readManifest } from "../../src/core/manifest.js";
import { access } from "node:fs/promises";

/** True when a path exists — asserting config.json is never created. */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

/** Stubs stdin TTY-ness: interactive branches check it, and vitest runs
 * headless (isTTY undefined = non-interactive) by default. */
function setStdinTty(isTty: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value: isTty, configurable: true });
}

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
  setStdinTty(true); // scripted-prompt tests simulate an interactive terminal
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
  setStdinTty(undefined);
  await rm(home, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe("vsync init — first run", () => {
  it("creates manifest and a global registry entry — no project config.json", async () => {
    projectRoot = await makeProject("app");
    script("my-app", "local-fs", [".env"]);

    await runInitCommand(projectRoot, {}, home);

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

    // The wiring snapshot is gone: init writes ONLY the manifest.
    expect(await exists(join(projectRoot, ".vsync", "config.json"))).toBe(false);

    const globalConfig = await readGlobalConfig(home);
    expect(globalConfig.projects).toEqual([
      { projectId: "my-app", path: projectRoot, backend: "local-fs", lastSyncedAt: undefined },
    ]);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Connection OK"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Initialized 'my-app'"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("run `vsync push`"));
  });

  it("defaults projectId to the folder name and passes candidates to the tree prompt", async () => {
    projectRoot = await makeProject("default-id");
    const defaultId = basename(projectRoot);
    script(defaultId, "local-fs", []);

    await runInitCommand(projectRoot, {}, home);

    expect(vi.mocked(input)).toHaveBeenCalledWith(expect.objectContaining({ default: defaultId }));
    expect(vi.mocked(treeCheckbox)).toHaveBeenCalledTimes(1);
    const { candidates } = vi.mocked(treeCheckbox).mock.calls[0][0];
    const env = candidates.find((c) => c.path === ".env");
    const notes = candidates.find((c) => c.path === "local-notes.txt");
    expect(env?.classification).toBe("boosted"); // pre-checked inside the prompt
    expect(notes?.classification).toBe("shown");
    // Suppressed node_modules never reaches the prompt.
    expect(candidates.some((c) => c.path.startsWith("node_modules/"))).toBe(false);
  });

  it("only tracks checkbox-selected files, not every candidate", async () => {
    projectRoot = await makeProject("unselected");
    script("unselected-app", "local-fs", ["local-notes.txt"]);

    await runInitCommand(projectRoot, {}, home);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files.map((f) => f.path)).toEqual(["local-notes.txt"]);
  });

  it("handles a project with no ignored files (no checkbox prompt, empty manifest)", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vsync-init-empty-"));
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await writeFile(join(projectRoot, "README.md"), "nothing ignored here");
    script("empty-app", "local-fs");

    await runInitCommand(projectRoot, {}, home);

    expect(vi.mocked(treeCheckbox)).not.toHaveBeenCalled();
    const manifest = await readManifest(projectRoot);
    expect(manifest!.files).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No files tracked yet"));
  });

  it("refuses a backend with no saved profile, pointing at vsync config", async () => {
    projectRoot = await makeProject("noprofile");
    script("noprofile-app", "sftp");

    await expect(runInitCommand(projectRoot, {}, home)).rejects.toThrow(
      /No saved profile for 'sftp'.*`vsync config`/,
    );
    // Nothing was written.
    expect(await readManifest(projectRoot)).toBeNull();
    expect(await exists(join(projectRoot, ".vsync", "config.json"))).toBe(false);
  });
});

describe("vsync init — non-interactive (flags, no prompts)", () => {
  beforeEach(() => setStdinTty(undefined)); // headless = non-interactive

  it("initializes from flags alone and never prompts", async () => {
    projectRoot = await makeProject("agent");

    await runInitCommand(
      projectRoot,
      { projectId: "agent-app", backend: "local-fs", files: [".env"] },
      home,
    );

    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(treeCheckbox).not.toHaveBeenCalled();
    const manifest = await readManifest(projectRoot);
    expect(manifest!.projectId).toBe("agent-app");
    expect(manifest!.files.map((f) => f.path)).toEqual([".env"]);
    expect(manifest!.files[0].hash).toBe(await hashFile(join(projectRoot, ".env")));
  });

  it("defaults projectId to the folder name, backend to the global default, tracks nothing", async () => {
    projectRoot = await makeProject("headless");

    await runInitCommand(projectRoot, {}, home);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.projectId).toBe(basename(projectRoot));
    expect(manifest!.backend).toBe("local-fs");
    expect(manifest!.files).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No files tracked yet"));
  });

  it("fails fast with no default backend and no --backend", async () => {
    projectRoot = await makeProject("nodefault");
    const config = await readGlobalConfig(home);
    config.defaultBackend = undefined;
    await writeGlobalConfig(config, home);

    await expect(runInitCommand(projectRoot, {}, home)).rejects.toThrow(
      /Non-interactive init: no default backend configured — pass --backend/,
    );
    expect(await readManifest(projectRoot)).toBeNull();
  });

  it("refuses re-init without --yes, proceeds with it", async () => {
    projectRoot = await makeProject("reinit-flag");
    await runInitCommand(projectRoot, { projectId: "once", files: [".env"] }, home);

    await expect(runInitCommand(projectRoot, { projectId: "twice" }, home)).rejects.toThrow(
      /already initialized — pass --yes/,
    );
    expect((await readManifest(projectRoot))!.projectId).toBe("once");

    await runInitCommand(projectRoot, { projectId: "twice", yes: true, files: [".env"] }, home);
    expect((await readManifest(projectRoot))!.projectId).toBe("twice");
  });

  it("aborts (nothing written) on a failed connection test", async () => {
    projectRoot = await makeProject("badconn");
    const config = await readGlobalConfig(home);
    config.profiles["local-fs"] = {
      backend: "local-fs",
      settings: { basePath: join(home, "no", "such", "dir") },
    };
    await writeGlobalConfig(config, home);

    await expect(runInitCommand(projectRoot, { projectId: "x" }, home)).rejects.toThrow(
      /Connection test failed.*init aborted/s,
    );
    expect(await readManifest(projectRoot)).toBeNull();
  });

  it("validates --files paths all-or-nothing", async () => {
    projectRoot = await makeProject("files-flag");

    await expect(
      runInitCommand(projectRoot, { projectId: "x", files: [".env,nope.txt"] }, home),
    ).rejects.toThrow(/'nope.txt' does not exist.*Nothing was initialized/s);
    expect(await readManifest(projectRoot)).toBeNull();
  });

  it("comma-splits and dedupes --files values, normalizes paths", async () => {
    projectRoot = await makeProject("files-split");

    await runInitCommand(
      projectRoot,
      { projectId: "x", files: [".env,local-notes.txt", "./.env"] },
      home,
    );

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files.map((f) => f.path).sort()).toEqual([".env", "local-notes.txt"]);
  });

  it("emits JSON output", async () => {
    projectRoot = await makeProject("json-init");

    await runInitCommand(
      projectRoot,
      { projectId: "json-app", backend: "local-fs", files: [".env"], json: true },
      home,
    );

    const raw = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .find((l) => l.trim().startsWith("{"));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({
      projectId: "json-app",
      backend: "local-fs",
      files: [".env"],
    });
  });
});

describe("vsync init --list", () => {
  it("prints candidates (suppressed filtered, boosted tagged) and writes nothing", async () => {
    projectRoot = await makeProject("list");

    await runInitCommand(projectRoot, { list: true }, home);

    const out = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(out).toContain(".env");
    expect(out).toContain("suggested");
    expect(out).toContain("local-notes.txt");
    expect(out).not.toContain("node_modules");
    expect(await readManifest(projectRoot)).toBeNull(); // works pre-init
  });

  it("emits candidates as JSON", async () => {
    projectRoot = await makeProject("list-json");

    await runInitCommand(projectRoot, { list: true, json: true }, home);

    const raw = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .find((l) => l.trim().startsWith("{"));
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string) as {
      candidates: { path: string; classification: string; rule?: string }[];
    };
    const env = parsed.candidates.find((c) => c.path === ".env");
    expect(env?.classification).toBe("boosted");
    expect(typeof env?.rule).toBe("string");
    expect(parsed.candidates.some((c) => c.path.startsWith("node_modules/"))).toBe(false);
  });
});

describe("vsync init — re-running on an initialized project", () => {
  it("warns and requires confirmation; abort leaves everything untouched", async () => {
    projectRoot = await makeProject("reinit");
    script("reinit-app", "local-fs", [".env"]);
    await runInitCommand(projectRoot, {}, home);

    const manifestBefore = await readFile(join(projectRoot, ".vsync", "manifest.json"), "utf8");

    vi.mocked(console.log).mockClear();
    script(false); // "Re-initialize anyway?" → no
    await runInitCommand(projectRoot, {}, home);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("already initialized"));
    expect(console.log).toHaveBeenCalledWith("Aborted — nothing changed.");
    expect(await readFile(join(projectRoot, ".vsync", "manifest.json"), "utf8")).toBe(
      manifestBefore,
    );
    const globalConfig = await readGlobalConfig(home);
    expect(globalConfig.projects).toHaveLength(1); // no duplicate entry either
  });

  it("overwrites when the user confirms", async () => {
    projectRoot = await makeProject("overwrite");
    script("overwrite-app", "local-fs", [".env", "local-notes.txt"]);
    await runInitCommand(projectRoot, {}, home);

    script(true, "overwrite-app", "local-fs", []); // re-init, deselect everything
    await runInitCommand(projectRoot, {}, home);

    const manifest = await readManifest(projectRoot);
    expect(manifest!.files).toEqual([]);
    const globalConfig = await readGlobalConfig(home);
    expect(globalConfig.projects).toHaveLength(1);
  });
});
