import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatusCommand } from "../../src/commands/status.js";
import { hashFile } from "../../src/core/hash.js";
import { readManifest, writeManifest, type ManifestFileEntry } from "../../src/core/manifest.js";
import { remoteKeyFor } from "../../src/utils/paths.js";

const execFileAsync = promisify(execFile);

let projectRoot: string | undefined;
let homeDir: string | undefined;
let remoteDir: string | undefined;
let logs: string[][] = [];

/**
 * A real git project the way `vsync init` leaves it, backed by a local-fs
 * backend. Tracked files start UNSYNCED unless `pushed` names them — for
 * those, the file is copied to the remote tree and the manifest entry gets
 * lastSyncedHash/lastSyncedAt stamped, exactly what a successful `push`
 * (Task 14) will do.
 */
async function makeProject(name: string, tracked: string[], pushed: string[] = []): Promise<void> {
  projectRoot = await mkdtemp(join(tmpdir(), `vsync-status-${name}-`));
  homeDir = await mkdtemp(join(tmpdir(), `vsync-status-${name}-home-`));
  remoteDir = await mkdtemp(join(tmpdir(), `vsync-status-${name}-remote-`));

  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  await writeFile(join(projectRoot, ".gitignore"), ".env*\nlocal-notes.txt\nsteady.txt\n");
  await writeFile(join(projectRoot, ".env"), "A=1\nB=2\n");
  await writeFile(join(projectRoot, "local-notes.txt"), "just some notes\n");
  await writeFile(join(projectRoot, "steady.txt"), "steady as she goes\n");
  await mkdir(join(projectRoot, "sub"), { recursive: true });
  await writeFile(join(projectRoot, "sub", "app.local.json"), '{ "debug": true }\n');

  await writeGlobalProfile();

  const files: ManifestFileEntry[] = [];
  for (const rel of tracked) {
    const abs = join(projectRoot, rel);
    const info = await stat(abs);
    files.push({
      path: rel,
      hash: await hashFile(abs),
      size: info.size,
      mtimeLocal: info.mtime.toISOString(),
    });
  }
  await writeManifest(projectRoot, { projectId: name, backend: "local-fs", files });

  for (const rel of pushed) {
    const dest = remotePathOf(name, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(projectRoot, rel), dest);
    const manifest = (await readManifest(projectRoot))!;
    const entry = manifest.files.find((f) => f.path === rel)!;
    entry.lastSyncedHash = entry.hash;
    entry.lastSyncedAt = new Date().toISOString();
    await writeManifest(projectRoot, manifest);
  }
}

/** Where the backend stores a tracked file of project `name` (keys are
 * "<projectId>/<path>") — build remote paths ONLY via this, never by
 * hand-joining a project name (a wrong projectId is exactly how the
 * deleted-remote test first failed). */
function remotePathOf(name: string, rel: string): string {
  return join(remoteDir!, remoteKeyFor(name, rel));
}

/** Minimal global config so backendResolver finds the profile + no secrets. */
async function writeGlobalProfile(): Promise<void> {
  await mkdir(join(homeDir!, ".vsync"), { recursive: true });
  await writeFile(
    join(homeDir!, ".vsync", "config.json"),
    JSON.stringify({
      profiles: { "local-fs": { backend: "local-fs", settings: { basePath: remoteDir } } },
      secrets: {},
      projects: [],
    }),
  );
}

/** Drives status and returns everything it printed, joined. */
async function runStatus(json = false): Promise<string> {
  logs.push([]);
  const lines = logs[logs.length - 1];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  await runStatusCommand(projectRoot!, homeDir, json);
  return lines.join("\n");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  logs = [];
  for (const dir of [projectRoot, homeDir, remoteDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  projectRoot = homeDir = remoteDir = undefined;
});

describe("vsync status", () => {
  it("categorizes unchanged / locally modified / remote modified / conflict", async () => {
    const tracked = [".env", "local-notes.txt", "sub/app.local.json", "steady.txt"];
    await makeProject("mixed", tracked, [...tracked]);

    // steady.txt: untouched on both sides → unchanged.
    // local-notes.txt: edited locally only.
    await writeFile(join(projectRoot!, "local-notes.txt"), "edited locally\n");
    // sub/app.local.json: edited remotely only.
    await writeFile(remotePathOf("mixed", "sub/app.local.json"), '{"debug":false}\n');
    // .env: edited BOTH sides → conflict.
    await writeFile(join(projectRoot!, ".env"), "A=2\n");
    await writeFile(remotePathOf("mixed", ".env"), "REMOTE=1\n");

    const out = await runStatus();

    expect(out).toContain("Project 'mixed' (backend: local-fs) — 4 tracked file(s)");
    expect(out).toMatch(/Conflicts[^\n]*:\s*\n\s*\.env\b/);
    expect(out).toMatch(/Changed locally[^\n]*:\s*\n\s*local-notes\.txt\b/);
    expect(out).toMatch(/Changed remotely[^\n]*:\s*\n\s*sub\/app\.local\.json\b/);
    expect(out).toMatch(/In sync:\s*\n\s*steady\.txt\b/);
    // Paths and statuses only — never contents ("edited locally" etc. are
    // the literal fixture strings; if any leaked into output, fail).
    expect(out).not.toContain("A=1");
    expect(out).not.toContain("REMOTE=1");
  });

  it("reports a never-synced tracked file as remote-missing", async () => {
    await makeProject("unsynced", ["local-notes.txt"]);
    const out = await runStatus();
    expect(out).toMatch(/Missing remotely[^\n]*:\s*\n\s*local-notes\.txt \(not pushed yet\)/);
  });

  it("reports a synced-then-remote-deleted file as remote-missing without a note", async () => {
    await makeProject("deleted-remote", [".env"], [".env"]);
    await rm(remotePathOf("deleted-remote", ".env"));
    const out = await runStatus();
    expect(out).toMatch(/Missing remotely[^\n]*:\s*\n\s*\.env\s*$/m);
    expect(out).not.toContain("not pushed yet");
  });

  it("reports a locally deleted file as missing-locally", async () => {
    await makeProject("gone", [".env", "steady.txt"], [".env", "steady.txt"]);
    await rm(join(projectRoot!, ".env"));
    const out = await runStatus();
    expect(out).toMatch(/Missing locally[^\n]*:\s*\n\s*\.env\b/);
    expect(out).toMatch(/In sync:\s*\n\s*steady\.txt\b/);
  });

  it("handles a project with zero tracked files", async () => {
    await makeProject("empty", []);
    const out = await runStatus();
    expect(out).toContain("Project 'empty' (backend: local-fs) — 0 tracked file(s)");
    expect(out).toContain("No tracked files yet — use `vsync add <path>` or re-run `vsync init`.");
  });

  it("requires an initialized project", async () => {
    const bare = await mkdtemp(join(tmpdir(), "vsync-status-bare-"));
    try {
      await expect(runStatusCommand(bare)).rejects.toThrow(/`vsync init`/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("vsync status --json", () => {
  it("emits per-file statuses as one JSON object on stdout", async () => {
    const tracked = [".env", "local-notes.txt", "steady.txt"];
    await makeProject("json-mixed", tracked, [...tracked]);
    await writeFile(join(projectRoot!, "local-notes.txt"), "edited locally\n");
    await rm(remotePathOf("json-mixed", ".env")); // synced-then-deleted remotely

    const out = await runStatus(true);

    const parsed = JSON.parse(out) as {
      projectId: string;
      backend: string;
      files: { path: string; status: string; note?: string }[];
    };
    expect(parsed.projectId).toBe("json-mixed");
    expect(parsed.backend).toBe("local-fs");
    expect(parsed.files).toEqual(
      expect.arrayContaining([
        { path: ".env", status: "remote-missing" },
        { path: "local-notes.txt", status: "local-modified" },
        { path: "steady.txt", status: "unchanged" },
      ]),
    );
    // One JSON object, nothing else on stdout.
    expect(out.trim().startsWith("{")).toBe(true);
  });

  it("notes never-pushed files inside their JSON entry", async () => {
    await makeProject("json-unsynced", ["local-notes.txt"]);
    const parsed = JSON.parse(await runStatus(true)) as { files: { note?: string }[] };
    expect(parsed.files[0].note).toBe("not pushed yet");
  });
});
