import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDiffCommand } from "../../src/commands/diff.js";
import { runPushCommand } from "../../src/commands/push.js";
import { hashFile } from "../../src/core/hash.js";
import { writeManifest } from "../../src/core/manifest.js";
import { indexKeyFor } from "../../src/core/remoteIndex.js";
import { remoteKeyFor } from "../../src/utils/paths.js";

const execFileAsync = promisify(execFile);

let projectRoot: string | undefined;
let homeDir: string | undefined;
let remoteDir: string | undefined;
let logs: string[][] = [];

/**
 * A real git project the way `vsync init` leaves it, backed by a local-fs
 * backend. Files named in `pushed` are synced with the REAL push (silent,
 * auto-confirmed) — remote copies plus the remote index.
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
  await writeManifest(projectRoot, {
    projectId: name,
    backend: "local-fs",
    files: tracked.map((path) => ({ path })),
  });

  if (pushed.length > 0) {
    await runPushCommand(projectRoot, true, homeDir, "silent");
  }
}

/** Where the backend stores a tracked file of project `name` — build remote
 * paths ONLY via this, never by hand-joining a project name. */
function remotePathOf(name: string, rel: string): string {
  return join(remoteDir!, remoteKeyFor(name, rel));
}

/** Where the backend stores this project's sidecar index. */
function indexPathOf(name: string): string {
  return join(remoteDir!, indexKeyFor(name));
}

/** Simulates "the other machine pushed new content": updates the remote
 * file AND its index entry, exactly what a real push does. */
async function setRemoteContent(name: string, rel: string, content: string): Promise<void> {
  const dest = remotePathOf(name, rel);
  await writeFile(dest, content);
  const info = await stat(dest);
  const indexPath = indexPathOf(name);
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    files: Record<string, { hash: string; size: number; pushedAt: string }>;
  };
  index.files[rel] = {
    hash: await hashFile(dest),
    size: info.size,
    pushedAt: new Date().toISOString(),
  };
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
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
async function runDiff(showValues = false, json = false): Promise<string> {
  logs.push([]);
  const lines = logs[logs.length - 1];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  await runDiffCommand(projectRoot!, showValues, homeDir, json);
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
    await setRemoteContent("mixed", "local-notes.txt", "edited remotely\n"); // remote edit

    const out = await runDiff();

    expect(out).toMatch(/Differ \(local ≠ remote[^\n]*:\s*\n\s*\.env\b/);
    expect(out).toMatch(/\n\s*local-notes\.txt\b/);
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

  it("lists never-pushed tracked files under not-on-remote", async () => {
    await makeProject("unsynced", ["local-notes.txt"]);
    const out = await runDiff();
    expect(out).toMatch(/Not on remote[^\n]*:\s*\n\s*local-notes\.txt\b/);
  });
});

describe("vsync diff --show-values", () => {
  it("shows a real line diff of local vs remote for a locally edited file (- remote, + local)", async () => {
    await makeProject("values", [".env"], [".env"]);
    await writeFile(join(projectRoot!, ".env"), "A=1\nB=CHANGED\nC=3\n");

    const out = await runDiff(true);

    expect(out).toMatch(/── \.env \(differs\) ──/);
    expect(out).toMatch(/-\s*B=2/);
    expect(out).toMatch(/\+\s*B=CHANGED/);
    expect(out).toMatch(/\+\s*C=3/);
  });

  it("shows remote-side changes against the local copy (remote is the - side)", async () => {
    await makeProject("remote-edit", ["local-notes.txt"], ["local-notes.txt"]);
    await setRemoteContent("remote-edit", "local-notes.txt", "edited on the server\n");

    const out = await runDiff(true);

    expect(out).toMatch(/── local-notes\.txt \(differs\) ──/);
    expect(out).toMatch(/-\s*edited on the server/);
    expect(out).toMatch(/\+\s*just some notes/);
  });

  it("summarizes binary files instead of line-diffing garbage", async () => {
    await makeProject("binary", ["steady.txt"], ["steady.txt"]);
    // Replace BOTH sides with binary content that differs (NUL bytes).
    const localBin = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    await writeFile(join(projectRoot!, "steady.txt"), localBin);
    await setRemoteContent("binary", "steady.txt", "text remote copy\n");
    // Force the pair to "differ" with binary local content: overwrite the
    // remote copy too (binary), then align the index so status = differs.
    const remoteBin = Buffer.from([0x00, 0x0a, 0x0b]);
    await writeFile(remotePathOf("binary", "steady.txt"), remoteBin);
    const info = await stat(remotePathOf("binary", "steady.txt"));
    const indexPath = indexPathOf("binary");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      files: Record<string, { hash: string; size: number; pushedAt: string }>;
    };
    index.files["steady.txt"] = {
      hash: await hashFile(remotePathOf("binary", "steady.txt")),
      size: info.size,
      pushedAt: new Date().toISOString(),
    };
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");

    const out = await runDiff(true);

    expect(out).toMatch(/── steady\.txt \(differs\) ──/);
    expect(out).toMatch(/binary — local \d+ B, remote \d+ B pushed/);
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

describe("vsync diff --json", () => {
  it("emits differing files + candidates; no patches without --show-values", async () => {
    await makeProject("json-plain", [".env", "steady.txt"], [".env", "steady.txt"]);
    await writeFile(join(projectRoot!, ".env"), "A=2\n"); // differs

    const parsed = JSON.parse(await runDiff(false, true)) as {
      projectId: string;
      backend: string;
      files: { path: string; status: string }[];
      candidates: { path: string; classification: string }[];
      patches?: unknown;
    };

    expect(parsed.projectId).toBe("json-plain");
    expect(parsed.backend).toBe("local-fs");
    expect(parsed.files).toEqual([{ path: ".env", status: "differs" }]);
    expect(parsed.candidates.some((c) => c.path === "local-notes.txt")).toBe(true);
    expect(parsed.patches).toBeUndefined(); // values stay hidden
  });

  it("includes patches only with --show-values", async () => {
    await makeProject("json-values", [".env"], [".env"]);
    await writeFile(join(projectRoot!, ".env"), "A=2\n");

    const parsed = JSON.parse(await runDiff(true, true)) as {
      patches?: { path: string; patch: string }[];
    };

    expect(parsed.patches).toHaveLength(1);
    expect(parsed.patches![0].path).toBe(".env");
    expect(parsed.patches![0].patch).toContain("+A=2");
  });
});
