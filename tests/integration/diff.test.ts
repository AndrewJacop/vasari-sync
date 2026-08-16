import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDiffCommand } from "../../src/commands/diff.js";
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
  projectRoot = await mkdtemp(join(tmpdir(), `vsync-diff-${name}-`));
  homeDir = await mkdtemp(join(tmpdir(), `vsync-diff-${name}-home-`));
  remoteDir = await mkdtemp(join(tmpdir(), `vsync-diff-${name}-remote-`));

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
 * hand-joining a project name. */
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

/** Drives diff and returns everything it printed, joined. */
async function runDiff(showValues = false): Promise<string> {
  logs.push([]);
  const lines = logs[logs.length - 1];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  await runDiffCommand(projectRoot!, showValues, homeDir);
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

describe("vsync diff (default, no --show-values)", () => {
  it("shows differing tracked files as paths only — never contents", async () => {
    const tracked = [".env", "local-notes.txt", "steady.txt"];
    await makeProject("mixed", tracked, [...tracked]);

    await writeFile(join(projectRoot!, ".env"), "A=2\n"); // local edit
    await writeFile(remotePathOf("mixed", "local-notes.txt"), "edited remotely\n"); // remote edit

    const out = await runDiff();

    expect(out).toMatch(/Changed locally[^\n]*:\s*\n\s*\.env\b/);
    expect(out).toMatch(/Changed remotely[^\n]*:\s*\n\s*local-notes\.txt\b/);
    // steady.txt is in sync → not listed as differing, not counted.
    expect(out).not.toMatch(/steady\.txt/);
    expect(out).toContain("3 tracked file(s), 2 differ");
    // Default must never print content — the literal fixture strings prove it.
    expect(out).not.toContain("A=1");
    expect(out).not.toContain("A=2");
    expect(out).not.toContain("edited remotely");
  });

  it("reports a cleanly-in-sync project without listing every file", async () => {
    await makeProject("clean", [".env", "steady.txt"], [".env", "steady.txt"]);
    const out = await runDiff();
    expect(out).toContain("2 tracked file(s), none differ");
  });

  it("lists never-pushed tracked files under missing-remotely", async () => {
    await makeProject("unsynced", ["local-notes.txt"]);
    const out = await runDiff();
    expect(out).toMatch(/Missing remotely[^\n]*:\s*\n\s*local-notes\.txt\b/);
  });
});

describe("vsync diff --show-values", () => {
  it("shows a real line diff for a locally modified file", async () => {
    await makeProject("values", [".env"], [".env"]);
    await writeFile(join(projectRoot!, ".env"), "A=1\nB=CHANGED\nC=3\n");

    const out = await runDiff(true);

    expect(out).toMatch(/── \.env \(local-modified\) ──/);
    expect(out).toMatch(/-\s*B=2/);
    expect(out).toMatch(/\+\s*B=CHANGED/);
    expect(out).toMatch(/\+\s*C=3/);
  });

  it("shows remote-side changes against the local copy", async () => {
    await makeProject("remote-edit", ["local-notes.txt"], ["local-notes.txt"]);
    await writeFile(remotePathOf("remote-edit", "local-notes.txt"), "edited on the server\n");

    const out = await runDiff(true);

    expect(out).toMatch(/── local-notes\.txt \(remote-modified\) ──/);
    expect(out).toMatch(/-\s*just some notes/);
    expect(out).toMatch(/\+\s*edited on the server/);
  });

  it("notes a missing remote copy instead of crashing", async () => {
    await makeProject("no-remote", ["steady.txt"]); // never pushed
    const out = await runDiff(true);
    expect(out).toMatch(/── steady\.txt \(remote-missing\) ──/);
    expect(out).toMatch(/no remote copy/);
  });

  it("does not content-diff in-sync files even though they're tracked", async () => {
    await makeProject("no-diff-clean", [".env"], [".env"]);
    const out = await runDiff(true);
    expect(out).toContain("1 tracked file(s), none differ");
    expect(out).not.toMatch(/── \.env/);
    expect(out).not.toContain("A=1");
  });
});

describe("vsync diff — untracked candidates section", () => {
  it("reflects scanner output: boosted suggested, tracked files excluded", async () => {
    await makeProject("cands", [".env"], [".env"]);
    // local-notes.txt + steady.txt are ignored by the fixture .gitignore but
    // untracked by the manifest → candidates. node_modules is suppressed.
    await mkdir(join(projectRoot!, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(projectRoot!, "node_modules", "pkg", "index.js"), "x\n");

    const out = await runDiff();

    expect(out).toMatch(
      /Untracked candidates[^\n]*:\s*\n\s*local-notes\.txt \(\d+ bytes\)\s*\n\s*steady\.txt \(\d+ bytes\)/,
    );
    // .env is tracked → must NOT appear as a candidate.
    expect(out).not.toMatch(/candidate[\s\S]*\.env\b/);
    // Suppressed dirs never appear.
    expect(out).not.toContain("node_modules");
  });

  it("prints a clean none-line when there are no candidates", async () => {
    // Track every ignored fixture file → no untracked candidates remain.
    await makeProject("no-cands", [".env", "local-notes.txt", "steady.txt"], [".env"]);
    const out = await runDiff();
    expect(out).toMatch(/Untracked candidates[^\n]*:\s*none/);
  });

  it("tags boosted candidates as suggested", async () => {
    await makeProject("boost", [".env"], [".env"]);
    // Another .env*-prefixed file, ignored and untracked → boosted.
    await writeFile(join(projectRoot!, ".env.local"), "X=9\n");

    const out = await runDiff();
    expect(out).toMatch(/\.env\.local \(\d+ bytes\) — suggested \(pattern:\.env\*\)/);
  });
});

describe("vsync diff — guards", () => {
  it("requires an initialized project", async () => {
    const bare = await mkdtemp(join(tmpdir(), "vsync-diff-bare-"));
    try {
      await expect(runDiffCommand(bare, false)).rejects.toThrow(/`vsync init`/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
