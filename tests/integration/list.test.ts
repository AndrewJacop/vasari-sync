import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runListCommand } from "../../src/commands/list.js";
import {
  readGlobalConfig,
  upsertProjectEntry,
  writeGlobalConfig,
  type GlobalConfig,
} from "../../src/core/globalConfig.js";

let homeDir: string | undefined;
let projectA: string | undefined;
let projectB: string | undefined;
let captured: string[][] = [];

async function makeHome(): Promise<void> {
  homeDir = await mkdtemp(join(tmpdir(), "vsync-list-home-"));
}

/** Registers projects directly in the global registry (what `init` leaves behind). */
async function writeRegistry(projects: GlobalConfig["projects"]): Promise<void> {
  const config = await readGlobalConfig(homeDir);
  config.projects = [];
  for (const entry of projects) upsertProjectEntry(config, entry);
  await writeGlobalConfig(config, homeDir);
}

/** Drives list and returns everything it printed, joined. */
async function runList(): Promise<string> {
  captured.push([]);
  const lines = captured[captured.length - 1];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  await runListCommand(homeDir);
  return lines.join("\n");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  captured = [];
  for (const dir of [homeDir, projectA, projectB]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  homeDir = projectA = projectB = undefined;
});

describe("vsync list", () => {
  it("shows multiple projects with id, backend, sync time, path — one deleted path marked missing, no crash", async () => {
    await makeHome();
    projectA = await mkdtemp(join(tmpdir(), "vsync-list-a-"));
    projectB = await mkdtemp(join(tmpdir(), "vsync-list-b-"));
    const syncedAt = "2026-08-15T10:22:00.000Z";
    await writeRegistry([
      { projectId: "alpha", path: projectA, backend: "local-fs", lastSyncedAt: syncedAt },
      { projectId: "beta", path: projectB, backend: "s3" }, // never synced
      // A path that existed once but is gone now (moved/deleted project).
      { projectId: "ghost", path: join(tmpdir(), "vsync-list-gone-404"), backend: "webdav" },
    ]);

    const out = await runList();

    expect(out).toContain("Known projects (3):");
    expect(out).toMatch(
      new RegExp(`alpha\\s+local-fs\\s+—\\s+2026-08-15 10:22\\s+${escapeRe(projectA)}$`, "m"),
    );
    expect(out).toMatch(
      new RegExp(`beta\\s+s3\\s+—\\s+never synced\\s+${escapeRe(projectB)}$`, "m"),
    );
    expect(out).toMatch(
      /ghost\s+webdav\s+—\s+never synced\s+\S+vsync-list-gone-404\s+\(missing on disk\)/,
    );
    // Existing projects must NOT carry the missing marker.
    expect(out).not.toMatch(new RegExp(`alpha.*${escapeRe(projectA)}\\s*\\(missing`));
  });

  it("prints a friendly hint when the registry is empty", async () => {
    await makeHome();
    const out = await runList();
    expect(out).toContain("No known projects — run `vsync init` inside a project directory first.");
  });

  it("hints at push when backends are configured but hold no projects", async () => {
    await makeHome();
    const remoteDir = await mkdtemp(join(tmpdir(), "vsync-list-remote-empty-"));
    await writeRegistry([]);
    const config = await readGlobalConfig(homeDir);
    config.profiles["local-fs"] = { backend: "local-fs", settings: { basePath: remoteDir } };
    await writeGlobalConfig(config, homeDir);
    await rm(remoteDir, { recursive: true, force: true });

    const out = await runList();

    expect(out).toContain("No projects on your backends yet");
  });

  it("lists remote-only projects a fresh machine has never linked — with a link hint", async () => {
    await makeHome();
    // Machine B scenario: no registry entries, but the backend holds files.
    const remoteDir = await mkdtemp(join(tmpdir(), "vsync-list-remote-"));
    projectA = remoteDir; // cleaned up in afterEach
    await mkdir(join(remoteDir, "OPTOLINK"), { recursive: true });
    await writeFile(join(remoteDir, "OPTOLINK", ".env"), "A=1");
    await writeFile(join(remoteDir, "OPTOLINK", "CLAUDE.md"), "notes");
    const stray = join(remoteDir, "README.md"); // root-level file: not a project
    await writeFile(stray, "not a project");
    await writeRegistry([]);
    const config = await readGlobalConfig(homeDir);
    config.profiles["local-fs"] = { backend: "local-fs", settings: { basePath: remoteDir } };
    await writeGlobalConfig(config, homeDir);

    const out = await runList();

    expect(out).toContain("Known projects (1):");
    expect(out).toMatch(
      /OPTOLINK\s+local-fs\s+2 files\s+not linked here — run `vsync link OPTOLINK`/,
    );
    expect(out).not.toContain("never synced");
  });

  it("warns about unreachable backend profiles without failing the listing", async () => {
    await makeHome();
    projectA = await mkdtemp(join(tmpdir(), "vsync-list-a2-"));
    const broken = await mkdtemp(join(tmpdir(), "vsync-list-remote-gone-"));
    await mkdir(join(broken, "ghosted"), { recursive: true });
    await writeFile(join(broken, "ghosted", ".env"), "A=1");
    await rm(broken, { recursive: true, force: true }); // basePath now nonexistent
    await writeRegistry([
      {
        projectId: "alpha",
        path: projectA,
        backend: "local-fs",
        lastSyncedAt: "2026-08-15T10:22:00.000Z",
      },
    ]);
    const config = await readGlobalConfig(homeDir);
    config.profiles["local-fs"] = { backend: "local-fs", settings: { basePath: broken } };
    await writeGlobalConfig(config, homeDir);

    const out = await runList();

    // Registry rows still print even when the listing fails; no file count.
    expect(out).toMatch(/alpha\s+local-fs\s+—\s+2026-08-15 10:22\s+/);
    expect(out).not.toContain("1 file");
  });

  it("creates the global config on demand for an empty home (no pre-existing file)", async () => {
    homeDir = await mkdtemp(join(tmpdir(), "vsync-list-fresh-"));
    const out = await runList();
    expect(out).toContain("No known projects");
  });

  it("shows a project whose path exists but only as a file (not a dir) without crashing", async () => {
    await makeHome();
    // stat() succeeds on a plain file too — treated as present (not missing).
    const oddPath = join(homeDir!, "not-a-dir");
    await writeFile(oddPath, "x");
    await writeRegistry([{ projectId: "odd", path: oddPath, backend: "sftp" }]);
    const out = await runList();
    expect(out).toMatch(
      new RegExp(`odd\\s+sftp\\s+—\\s+never synced\\s+${escapeRe(oddPath)}$`, "m"),
    );
    expect(out).not.toContain("(missing on disk)");
  });

  it("works from the real CLI registration (list has no project-root dependency)", async () => {
    await makeHome();
    projectA = await mkdtemp(join(tmpdir(), "vsync-list-cli-"));
    await mkdir(join(projectA, ".vsync"), { recursive: true });
    await writeRegistry([
      {
        projectId: "cli-check",
        path: projectA,
        backend: "local-fs",
        lastSyncedAt: "2026-08-16T09:00:00.000Z",
      },
    ]);
    const out = await runList();
    expect(out).toContain("cli-check");
    expect(out).toContain("2026-08-16 09:00");
  });

  it("deduplicates: a project both linked locally and present on the backend is one row", async () => {
    await makeHome();
    const remoteDir = await mkdtemp(join(tmpdir(), "vsync-list-remote-dup-"));
    projectA = await mkdtemp(join(tmpdir(), "vsync-list-dup-"));
    await mkdir(join(remoteDir, "alpha"), { recursive: true });
    await writeFile(join(remoteDir, "alpha", ".env"), "A=1");
    await writeRegistry([
      {
        projectId: "alpha",
        path: projectA,
        backend: "local-fs",
        lastSyncedAt: "2026-08-16T09:00:00.000Z",
      },
    ]);
    const config = await readGlobalConfig(homeDir);
    config.profiles["local-fs"] = { backend: "local-fs", settings: { basePath: remoteDir } };
    await writeGlobalConfig(config, homeDir);

    const out = await runList();

    expect(out).toContain("Known projects (1):");
    expect(out).toMatch(
      new RegExp(`alpha\\s+local-fs\\s+1 file\\s+2026-08-16 09:00\\s+${escapeRe(projectA)}$`, "m"),
    );
    expect(out).not.toContain("not linked here");
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
