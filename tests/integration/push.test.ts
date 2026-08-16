import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPushCommand } from "../../src/commands/push.js";
import { readGlobalConfig } from "../../src/core/globalConfig.js";
import { hashFile } from "../../src/core/hash.js";
import { writeManifest } from "../../src/core/manifest.js";
import { indexKeyFor } from "../../src/core/remoteIndex.js";
import { remoteKeyFor } from "../../src/utils/paths.js";

const execFileAsync = promisify(execFile);

/** Scripted prompts: push asks for confirmation when interactive. */
const q = vi.hoisted(() => ({ answers: [] as unknown[] }));
vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(async () => q.answers.shift()),
}));

import { confirm } from "@inquirer/prompts";

let projectRoot: string | undefined;
let homeDir: string | undefined;
let remoteDir: string | undefined;

/**
 * A real git project the way `vsync init` leaves it, backed by a local-fs
 * backend. Files named in `pushed` are synced with the REAL push (silent,
 * auto-confirmed) — the only honest way to produce "previously pushed"
 * state, remote copies AND the remote index together.
 */
async function makeProject(name: string, tracked: string[], pushed: string[] = []): Promise<void> {
  projectRoot = await mkdtemp(join(tmpdir(), `vsync-push-${name}-`));
  homeDir = await mkdtemp(join(tmpdir(), `vsync-push-${name}-home-`));
  remoteDir = await mkdtemp(join(tmpdir(), `vsync-push-${name}-remote-`));

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

/** Remote-side location of a tracked file — always via remoteKeyFor, never
 * a hand-joined projectId (a wrong ID is exactly how fixtures rot). */
function remotePathOf(name: string, rel: string): string {
  return join(remoteDir!, remoteKeyFor(name, rel));
}

/** Where the backend stores this project's sidecar index. */
function indexPathOf(name: string): string {
  return join(remoteDir!, indexKeyFor(name));
}

/** The remote index as parsed JSON (fails the test if missing). */
async function readRemoteIndex(
  name: string,
): Promise<{ files: Record<string, { hash: string; size: number; pushedAt: string }> }> {
  return JSON.parse(await readFile(indexPathOf(name), "utf8"));
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

/** Drives push with console captured; `err` holds a thrown aggregate (if
 * any) instead of letting it escape — tests decide what to expect. */
async function runPush(
  yes = false,
  output: "prose" | "json" | "silent" = "prose",
): Promise<{ out: string; warns: string[]; err?: unknown }> {
  const lines: string[] = [];
  const warns: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });
  let err: unknown;
  try {
    await runPushCommand(projectRoot!, yes, homeDir, output);
  } catch (e) {
    err = e;
  }
  return { out: lines.join("\n"), warns, err };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of [projectRoot, homeDir, remoteDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  projectRoot = homeDir = remoteDir = undefined;
});

describe("vsync push", () => {
  it("clean push of new (never-pushed) files uploads, writes the remote index, and registers the project", async () => {
    const tracked = [".env", "local-notes.txt", "sub/app.local.json"];
    await makeProject("clean", tracked);

    const { out, err } = await runPush();

    expect(err).toBeUndefined();
    for (const rel of tracked) {
      // Remote copy exists and matches local content exactly.
      expect(await readFile(remotePathOf("clean", rel), "utf8")).toBe(
        await readFile(join(projectRoot!, rel), "utf8"),
      );
      expect(out).toMatch(new RegExp(`${rel.replace(/\//g, "\\/")} — pushed`));
    }
    // The sidecar index exists and records each pushed file's real hash.
    const index = await readRemoteIndex("clean");
    for (const rel of tracked) {
      expect(index.files[rel]).toMatchObject({
        hash: await hashFile(join(projectRoot!, rel)),
      });
      expect(typeof index.files[rel].pushedAt).toBe("string");
    }
    // Global registry stamped for `vsync list`.
    const registry = (await readGlobalConfig(homeDir)).projects;
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      projectId: "clean",
      backend: "local-fs",
      path: projectRoot,
    });
    expect(registry[0].lastSyncedAt).toBeTruthy();
    expect(out).toContain("Summary: 3 pushed");
  });

  it("is a no-op on unchanged files — nothing re-uploaded, index untouched", async () => {
    await makeProject("noop", [".env", "steady.txt"]);
    await runPush(true, "silent");
    const indexBefore = await readFile(indexPathOf("noop"), "utf8");

    const second = await runPush();

    expect(second.err).toBeUndefined();
    expect(second.out).toMatch(/\.env — skipped \(unchanged\)/);
    expect(second.out).toMatch(/steady\.txt — skipped \(unchanged\)/);
    expect(second.out).toContain("Summary: 2 skipped (unchanged)");
    expect(await readFile(indexPathOf("noop"), "utf8")).toBe(indexBefore);
  });

  it("overwrites the remote copy when the file differs — local wins, no refusals", async () => {
    await makeProject("overwrite", [".env"], [".env"]);
    await writeFile(join(projectRoot!, ".env"), "A=99\n"); // local side changes

    const { out, err } = await runPush();

    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — pushed/);
    expect(await readFile(remotePathOf("overwrite", ".env"), "utf8")).toBe("A=99\n");
    // Index now records the new content's hash.
    const index = await readRemoteIndex("overwrite");
    expect(index.files[".env"].hash).toBe(await hashFile(join(projectRoot!, ".env")));
  });

  it("trusts the index: a backend file changed behind the index's back is invisible (skipped)", async () => {
    await makeProject("behind", [".env"], [".env"]);
    // Someone edits the backend directly — the index still describes the
    // pushed content, so push (correctly, per the design) sees no change.
    await writeFile(remotePathOf("behind", ".env"), "ROGUE=1\n");

    const { out, err } = await runPush();

    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — skipped \(unchanged\)/);
    expect(await readFile(remotePathOf("behind", ".env"), "utf8")).toBe("ROGUE=1\n");
  });

  it("mirror semantics: a file deleted locally is deleted on the backend and dropped from the index", async () => {
    await makeProject("mirror-del", [".env", "steady.txt"], [".env", "steady.txt"]);
    await rm(join(projectRoot!, ".env"));

    const { out, err } = await runPush();

    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — deleted on the backend/);
    expect(out).toMatch(/steady\.txt — skipped \(unchanged\)/);
    await expect(stat(remotePathOf("mirror-del", ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const index = await readRemoteIndex("mirror-del");
    expect(index.files[".env"]).toBeUndefined();
    expect(index.files["steady.txt"]).toBeDefined();
  });

  it("reports a tracked file that exists nowhere as vanished, still pushes the others", async () => {
    await makeProject("gone", [".env", "steady.txt"]);
    await rm(join(projectRoot!, ".env"));
    // Never pushed → no remote index at all: the file exists nowhere.

    const { out, err } = await runPush();

    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — skipped \(no local copy, no remote copy\)/);
    expect(out).toMatch(/steady\.txt — pushed/);
    expect(out).toContain("Summary: 1 pushed, 1 skipped (vanished)");
  });

  it("partial failure: a failed upload still indexes successful files; the failed one stays unindexed", async () => {
    await makeProject("partial", [".env", "steady.txt"]);
    // Sink the backend call for steady.txt: a DIRECTORY at its remote
    // destination makes copyFile fail (EISDIR on POSIX, EPERM on Windows).
    await mkdir(remotePathOf("partial", "steady.txt"), { recursive: true });

    const { out, err } = await runPush();

    expect(errMsg(err)).toMatch(/Push incomplete — 1 failed to transfer/);
    expect(out).toMatch(/\.env — pushed/);
    expect(out).toMatch(/steady\.txt — FAILED \(/);
    // The index records only the success — it still describes the remote.
    const index = await readRemoteIndex("partial");
    expect(index.files[".env"]).toBeDefined();
    expect(index.files["steady.txt"]).toBeUndefined();
    expect(await readFile(remotePathOf("partial", ".env"), "utf8")).toBe("A=1\nB=2\n");
  });

  it("asks for confirmation and aborts cleanly when declined (nothing transfers)", async () => {
    await makeProject("confirm-no", [".env"]);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    q.answers = [false];

    const { out, err } = await runPush();

    expect(err).toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    expect(out).toContain("Upload (new on the backend):");
    expect(out).toContain("Aborted — nothing was pushed.");
    await expect(stat(remotePathOf("confirm-no", ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("confirmation names overwrites and deletions with dates on both sides", async () => {
    await makeProject("confirm-detail", [".env", "steady.txt"], [".env", "steady.txt"]);
    await writeFile(join(projectRoot!, ".env"), "A=2\n"); // differs
    await rm(join(projectRoot!, "steady.txt")); // will be deleted remotely
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    q.answers = [true];

    const { out, err } = await runPush();

    expect(err).toBeUndefined();
    expect(out).toContain("Upload (OVERWRITE the remote copy — local wins):");
    expect(out).toMatch(/\.env \(local edited \d{4}-\d{2}-\d{2}/);
    expect(out).toContain("DELETE on the backend (missing locally):");
    expect(out).toMatch(/steady\.txt \(remote pushed \d{4}-\d{2}-\d{2}/);
    expect(await readFile(remotePathOf("confirm-detail", ".env"), "utf8")).toBe("A=2\n");
  });

  it("handles a project with zero tracked files", async () => {
    await makeProject("empty", []);
    const { out, err } = await runPush();
    expect(err).toBeUndefined();
    expect(out).toContain("Project 'empty' (backend: local-fs) — 0 tracked file(s)");
    expect(out).toContain("No tracked files yet — use `vsync add <path>` or re-run `vsync init`.");
  });

  it("requires an initialized project", async () => {
    const bare = await mkdtemp(join(tmpdir(), "vsync-push-bare-"));
    try {
      await expect(runPushCommand(bare, false)).rejects.toThrow(/`vsync init`/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("vsync push --json", () => {
  it("emits one result object on stdout, per-file outcomes included", async () => {
    await makeProject("json-clean", [".env", "steady.txt"]);
    await runPush(true, "silent");
    await writeFile(join(projectRoot!, ".env"), "A=2\n"); // differs

    const { out, err } = await runPush(false, "json");

    expect(err).toBeUndefined();
    const parsed = JSON.parse(out) as {
      projectId: string;
      files: { path: string; outcome: string }[];
      summary: Record<string, number>;
    };
    expect(parsed.projectId).toBe("json-clean");
    expect(parsed.files).toEqual(
      expect.arrayContaining([
        { path: ".env", outcome: "pushed" },
        { path: "steady.txt", outcome: "skipped-unchanged" },
      ]),
    );
    expect(parsed.summary).toEqual({ pushed: 1, "skipped-unchanged": 1 });
    expect(out.trim().startsWith("{")).toBe(true);
    expect(out).not.toContain("tracked file(s)");
  });

  it("prints the result BEFORE throwing on an incomplete push", async () => {
    await makeProject("json-fail", [".env"]);
    await mkdir(remotePathOf("json-fail", ".env"), { recursive: true }); // upload sink

    const { out, err } = await runPush(false, "json");

    expect(err).toBeInstanceOf(Error);
    expect(errMsg(err)).toMatch(/Push incomplete/);
    const parsed = JSON.parse(out) as { files: { outcome: string }[] };
    expect(parsed.files[0].outcome).toBe("failed");
  });

  it("silent mode prints nothing, still uploads and writes the index", async () => {
    await makeProject("silent", [".env"]);

    const { out } = await runPush(true, "silent");

    expect(out).toBe("");
    expect(await readFile(remotePathOf("silent", ".env"), "utf8")).toBe("A=1\nB=2\n");
    expect((await readRemoteIndex("silent")).files[".env"]).toBeDefined();
  });
});
