import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Task 17 — the whole command set in ONE user session against the local-fs
 * backend: init → status → push → edit → status → diff → push → add →
 * push → rm → pull-on-a-fresh-clone → list. Sequential steps only — every
 * step starts from the state the previous one left behind, exactly like
 * real usage; no fixtures are hand-forged mid-flow (except the user's own
 * file edits).
 *
 * Set VSYNC_E2E_TRANSCRIPT=<file> to dump the captured session as a
 * transcript (used for the task report; off in normal test runs).
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

import { runAddCommand } from "../../src/commands/add.js";
import { runDiffCommand } from "../../src/commands/diff.js";
import { runInitCommand } from "../../src/commands/init.js";
import { runListCommand } from "../../src/commands/list.js";
import { runPullCommand } from "../../src/commands/pull.js";
import { runPushCommand } from "../../src/commands/push.js";
import { runRmCommand } from "../../src/commands/rm.js";
import { runStatusCommand } from "../../src/commands/status.js";
import { readGlobalConfig, writeGlobalConfig } from "../../src/core/globalConfig.js";
import { hashFile } from "../../src/core/hash.js";
import { readManifest } from "../../src/core/manifest.js";
import { remoteKeyFor } from "../../src/utils/paths.js";

const execFileAsync = promisify(execFile);

const transcript: string[] = [];
const scratchDirs: string[] = [];

/** Remote-side location of a tracked file — via remoteKeyFor, never a
 * hand-joined projectId (a wrong ID is exactly how fixtures rot). */
function remotePathOf(projectId: string, rel: string, remoteDir: string): string {
  return join(remoteDir, remoteKeyFor(projectId, rel));
}

/** Runs one command with fresh console spies, banners it into the
 * transcript, and returns everything it printed, joined. */
async function run(label: string, fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  transcript.push(`$ vsync ${label}`);
  try {
    await fn();
  } finally {
    transcript.push(...lines, "");
  }
  return lines.join("\n");
}

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  }); // undo the interactive stub set by the session below
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
  scratchDirs.length = 0;
});

describe("vsync end-to-end — a full user session on local-fs", () => {
  it(
    "init → status → push → edit → status → diff → push → add → push → rm → clone-pull → list",
    { timeout: 120_000 },
    async () => {
      // Scripted prompts need the interactive branches to fire (vitest runs
      // headless, which reads as non-interactive).
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      // ── Machine A, fresh project ─────────────────────────────────────
      const projectRoot = await mkdtemp(join(tmpdir(), "vsync-e2e-app-"));
      const home = await mkdtemp(join(tmpdir(), "vsync-e2e-home-"));
      const remoteDir = await mkdtemp(join(tmpdir(), "vsync-e2e-remote-"));
      scratchDirs.push(projectRoot, home, remoteDir);

      await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
      await writeFile(
        join(projectRoot, ".gitignore"),
        ".env*\nlocal-notes.txt\n*.key\nnode_modules/\n",
      );
      await writeFile(join(projectRoot, "README.md"), "# demo\n");
      await writeFile(join(projectRoot, ".env"), "A=1\nB=2\n");
      await writeFile(join(projectRoot, "local-notes.txt"), "just some notes\n");
      await writeFile(join(projectRoot, "extra.key"), "api-key-xyz\n"); // ignored, boosted
      await mkdir(join(projectRoot, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(projectRoot, "node_modules", "pkg", "index.js"), "module.exports=1;");

      // The user already ran `vsync config` (a local-fs profile exists).
      await writeGlobalConfig(
        {
          profiles: { "local-fs": { backend: "local-fs", settings: { basePath: remoteDir } } },
          secrets: {},
          projects: [],
          defaultBackend: "local-fs",
        },
        home,
      );

      // ── init: pick the project id, backend, and starting files ───────
      // Prompt order: projectId input → backend select → files tree prompt.
      // extra.key is boosted/pre-checked but deliberately left unselected
      // here — the user adds it later via `vsync add`.
      q.answers = ["demo-app", "local-fs", [".env", "local-notes.txt"]];
      const initOut = await run("init", () => runInitCommand(projectRoot, {}, home));

      expect(initOut).toContain("Connection OK");
      expect(initOut).toContain("Initialized 'demo-app'");
      const manifest = (await readManifest(projectRoot))!;
      expect(manifest.projectId).toBe("demo-app");
      expect(manifest.files.map((f) => f.path)).toEqual([".env", "local-notes.txt"]);
      // Manifest entries are a tracked-paths list — no sync state lives here.
      expect((await readGlobalConfig(home)).projects).toEqual([
        { projectId: "demo-app", path: projectRoot, backend: "local-fs", lastSyncedAt: undefined },
      ]);

      // ── status: nothing synced yet ─────────────────────────────────
      const status1 = await run("status", () => runStatusCommand(projectRoot, home));
      expect(status1).toContain("Project 'demo-app' (backend: local-fs) — 2 tracked file(s)");
      expect(status1).toContain("Not on remote (never pushed, or deleted there):");
      expect(status1).toContain("  .env");
      expect(status1).toContain("  local-notes.txt");
      expect(status1).not.toContain("In sync:"); // nothing synced yet

      // ── push: first upload of both files ───────────────────────────
      const push1 = await run("push", () => runPushCommand(projectRoot, true, home));
      expect(push1).toContain("  .env — pushed");
      expect(push1).toContain("  local-notes.txt — pushed");
      expect(push1).toContain("Summary: 2 pushed");
      for (const rel of [".env", "local-notes.txt"]) {
        expect(await readFile(remotePathOf("demo-app", rel, remoteDir), "utf8")).toBe(
          await readFile(join(projectRoot, rel), "utf8"),
        );
      }
      // The remote index records both files with their real hashes.
      const index1 = JSON.parse(
        await readFile(join(remoteDir, "demo-app", ".vsync-index.json"), "utf8"),
      ) as { files: Record<string, { hash: string }> };
      expect(index1.files[".env"].hash).toBe(await hashFile(join(projectRoot, ".env")));
      expect(index1.files["local-notes.txt"].hash).toBe(
        await hashFile(join(projectRoot, "local-notes.txt")),
      );
      expect((await readGlobalConfig(home)).projects[0].lastSyncedAt).toBeTruthy();

      // ── the user edits .env ──────────────────────────────────────────
      await writeFile(join(projectRoot, ".env"), "A=1\nB=2\nC=3\n");

      // ── status: shows the local modification ───────────────────────
      const status2 = await run("status", () => runStatusCommand(projectRoot, home));
      expect(status2).toContain("Differ (local ≠ remote — push or pull to align):");
      expect(status2).toContain("  .env");
      expect(status2).toContain("In sync:");
      expect(status2).toContain("  local-notes.txt");

      // ── diff: paths only by default + untracked candidates ───────
      const diff1 = await run("diff", () => runDiffCommand(projectRoot, false, home));
      expect(diff1).toContain("Differ (local ≠ remote — push or pull to align):");
      expect(diff1).toContain("  .env");
      expect(diff1).toContain("Untracked candidates (same scan as `vsync init`):");
      expect(diff1).toMatch(/extra\.key \(\d+ bytes\) — suggested \(pattern:\*\.key\)/);
      expect(diff1).not.toContain("C=3"); // values hidden without --show-values
      expect(diff1).not.toContain("node_modules"); // suppressed dirs never listed

      // ── push again: only the modified file travels ─────────────
      const push2 = await run("push", () => runPushCommand(projectRoot, true, home));
      expect(push2).toMatch(/\.env — pushed/);
      expect(push2).toMatch(/local-notes\.txt — skipped \(unchanged\)/);
      expect(push2).toContain("Summary: 1 pushed, 1 skipped (unchanged)");
      expect(await readFile(remotePathOf("demo-app", ".env", remoteDir), "utf8")).toBe(
        "A=1\nB=2\nC=3\n",
      );

      // ── add a new file, then push it ─────────────────────────────────
      const add1 = await run("add extra.key", () => runAddCommand(projectRoot, ["extra.key"]));
      expect(add1).toContain("Added 1 file(s) to tracking: extra.key.");
      expect(add1).toContain("Nothing was uploaded");
      expect((await readManifest(projectRoot))!.files.map((f) => f.path)).toEqual([
        ".env",
        "extra.key",
        "local-notes.txt",
      ]);

      const push3 = await run("push", () => runPushCommand(projectRoot, true, home));
      expect(push3).toMatch(/extra\.key — pushed/);
      expect(push3).toContain("Summary: 1 pushed, 2 skipped (unchanged)");
      expect(await readFile(remotePathOf("demo-app", "extra.key", remoteDir), "utf8")).toBe(
        "api-key-xyz\n",
      );

      // ── rm a file: untracked everywhere but disk and storage ─────────
      const rm1 = await run("rm local-notes.txt", () =>
        runRmCommand(projectRoot, ["local-notes.txt"]),
      );
      expect(rm1).toContain("Removed 1 file(s) from tracking: local-notes.txt.");
      expect(rm1).toContain("Local files were NOT deleted");
      expect((await readManifest(projectRoot))!.files.map((f) => f.path)).toEqual([
        ".env",
        "extra.key",
      ]);
      expect(await readFile(join(projectRoot, "local-notes.txt"), "utf8")).toBe(
        "just some notes\n", // local copy untouched
      );
      expect(await readFile(remotePathOf("demo-app", "local-notes.txt", remoteDir), "utf8")).toBe(
        "just some notes\n",
      ); // remote copy stays until deleted there

      // ── machine B: a fresh clone pulls everything back ───────────────
      // A git clone carries the committed files only: .vsync/ (manifest +
      // config are checked in), .gitignore, README — never the gitignored
      // tracked files themselves.
      const cloneRoot = await mkdtemp(join(tmpdir(), "vsync-e2e-clone-"));
      scratchDirs.push(cloneRoot);
      await cp(join(projectRoot, ".vsync"), join(cloneRoot, ".vsync"), { recursive: true });
      await cp(join(projectRoot, ".gitignore"), join(cloneRoot, ".gitignore"));
      await cp(join(projectRoot, "README.md"), join(cloneRoot, "README.md"));
      await expect(stat(join(cloneRoot, ".env"))).rejects.toThrow();
      await expect(stat(join(cloneRoot, "extra.key"))).rejects.toThrow();

      const pull1 = await run("pull   (in the fresh clone)", () =>
        runPullCommand(cloneRoot, true, home),
      );
      expect(pull1).toContain("Project 'demo-app' (backend: local-fs) — 2 tracked file(s)");
      expect(pull1).toContain("  .env — restored (was missing locally)");
      expect(pull1).toContain("  extra.key — restored (was missing locally)");
      expect(pull1).toContain("Summary: 2 restored");
      // The clone reconstructed machine A's exact content.
      expect(await readFile(join(cloneRoot, ".env"), "utf8")).toBe("A=1\nB=2\nC=3\n");
      expect(await readFile(join(cloneRoot, "extra.key"), "utf8")).toBe("api-key-xyz\n");
      // Untracked by then — the clone must NOT reconstruct local-notes.txt.
      await expect(stat(join(cloneRoot, "local-notes.txt"))).rejects.toThrow();

      // Clone is now in sync: a second pull is a clean no-op.
      const pull2 = await run("pull   (in the fresh clone)", () =>
        runPullCommand(cloneRoot, true, home),
      );
      expect(pull2).toContain("Summary: 2 skipped (unchanged)");

      // ── list: the registry shows the project, last-synced stamped ────
      const list1 = await run("list", () => runListCommand(home));
      expect(list1).toContain("Known projects (1):");
      expect(list1).toContain("demo-app");
      expect(list1).toContain("local-fs");
      expect(list1).toContain(cloneRoot);
      expect(list1).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/); // real sync time
      expect(list1).not.toContain("never synced");
      expect(list1).not.toContain("(missing on disk)");
      // One registry entry per projectId — the clone's pull re-pointed it.
      expect((await readGlobalConfig(home)).projects).toEqual([
        {
          projectId: "demo-app",
          path: cloneRoot,
          backend: "local-fs",
          lastSyncedAt: expect.any(String),
        },
      ]);

      if (process.env.VSYNC_E2E_TRANSCRIPT) {
        await writeFile(process.env.VSYNC_E2E_TRANSCRIPT, transcript.join("\n"), "utf8");
      }
    },
  );
});
