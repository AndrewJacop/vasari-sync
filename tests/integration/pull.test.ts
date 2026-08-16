import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPullCommand } from "../../src/commands/pull.js";
import { runPushCommand } from "../../src/commands/push.js";
import { readGlobalConfig } from "../../src/core/globalConfig.js";
import { hashFile } from "../../src/core/hash.js";
import { writeManifest } from "../../src/core/manifest.js";
import { indexKeyFor } from "../../src/core/remoteIndex.js";
import { remoteKeyFor } from "../../src/utils/paths.js";

const execFileAsync = promisify(execFile);

/** Scripted prompts: pull asks for confirmation when interactive. */
const q = vi.hoisted(() => ({ answers: [] as unknown[] }));
vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(async () => q.answers.shift()),
}));

import { confirm } from "@inquirer/prompts";

let projectRoot: string | undefined;
let homeDir: string | undefined;
let remoteDir: string | undefined;

/**
 * A real git project the way `vsync init` + a successful `push` leaves it,
 * backed by a local-fs backend: real remote copies AND the remote index.
 */
async function makeProject(name: string, tracked: string[], pushed: string[] = []): Promise<void> {
  projectRoot = await mkdtemp(join(tmpdir(), `vsync-pull-${name}-`));
  homeDir = await mkdtemp(join(tmpdir(), `vsync-pull-${name}-home-`));
  remoteDir = await mkdtemp(join(tmpdir(), `vsync-pull-${name}-remote-`));

  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  await writeFile(join(projectRoot, ".gitignore"), ".env*\nlocal-notes.txt\nsteady.txt\n");
  await writeFile(join(projectRoot, ".env"), "A=1\nB=2\n");
  await writeFile(join(projectRoot, "local-notes.txt"), "just some notes\n");
  await writeFile(join(projectRoot, "steady.txt"), "steady as she goes\n");
  await mkdir(join(projectRoot, "sub"), { recursive: true });
  await writeFile(join(projectRoot, "sub", "app.local.json"), '{ "debug": true }\n');
  await mkdir(join(projectRoot, "blocked"), { recursive: true });
  await writeFile(join(projectRoot, "blocked", "inner.txt"), "inner content\n");
  await writeFile(join(projectRoot, "fresh.txt"), "fresh and never pushed\n");

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

/** Remote-side location of a tracked file — always via remoteKeyFor. */
function remotePathOf(name: string, rel: string): string {
  return join(remoteDir!, remoteKeyFor(name, rel));
}

/** Where the backend stores this project's sidecar index. */
function indexPathOf(name: string): string {
  return join(remoteDir!, indexKeyFor(name));
}

/**
 * Simulates "the other machine pushed new content": writes the remote file
 * AND updates its index entry — exactly what a real push does to the
 * backend state pull compares against.
 */
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

/** Drives pull with console captured; `err` holds a thrown aggregate (if
 * any) instead of letting it escape — tests decide what to expect. */
async function runPull(
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
    await runPullCommand(projectRoot!, yes, homeDir, output);
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

describe("vsync pull", () => {
  it("downloads remotely-changed files, overwriting local — no refusal, no conflict states", async () => {
    const tracked = [".env", "local-notes.txt", "sub/app.local.json"];
    await makeProject("clean", tracked, tracked);
    // The other machine changed all three remote copies.
    await setRemoteContent("clean", ".env", "A=42\nB=2\n");
    await setRemoteContent("clean", "local-notes.txt", "remotely edited notes\n");
    await setRemoteContent("clean", "sub/app.local.json", '{ "debug": false }\n');
    // …and this machine ALSO edited .env locally: remote still wins on pull.
    await writeFile(join(projectRoot!, ".env"), "LOCAL-EDIT\n");

    const { out, err } = await runPull();

    expect(err).toBeUndefined();
    for (const rel of tracked) {
      expect(await readFile(join(projectRoot!, rel), "utf8")).toBe(
        await readFile(remotePathOf("clean", rel), "utf8"),
      );
      expect(out).toMatch(new RegExp(`${rel.replace(/\//g, "\\/")} — pulled`));
    }
    // The local-only edit to .env was overwritten by design (remote wins).
    expect(await readFile(join(projectRoot!, ".env"), "utf8")).toBe("A=42\nB=2\n");
    // Global registry stamped for `vsync list`.
    const registry = (await readGlobalConfig(homeDir)).projects;
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      projectId: "clean",
      backend: "local-fs",
      path: projectRoot,
    });
    expect(registry[0].lastSyncedAt).toBeTruthy();
    expect(out).toContain("Summary: 3 pulled");
  });

  it("is a no-op on unchanged files — nothing re-downloaded, registry untouched", async () => {
    await makeProject("noop", [".env", "steady.txt"], [".env", "steady.txt"]);
    const registryBefore = (await readGlobalConfig(homeDir)).projects;

    const { out, err } = await runPull();

    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — skipped \(unchanged\)/);
    expect(out).toMatch(/steady\.txt — skipped \(unchanged\)/);
    expect(out).toContain("Summary: 2 skipped (unchanged)");
    // The no-op pull left the registry exactly as the fixture push set it.
    expect((await readGlobalConfig(homeDir)).projects).toEqual(registryBefore);
  });

  it("restores a locally-missing file from the backend (fresh-clone / deleted-locally case)", async () => {
    const tracked = [".env", "sub/app.local.json"];
    await makeProject("clone", tracked, tracked);
    // Simulate machine B: manifest present, tracked files absent locally.
    await rm(join(projectRoot!, ".env"));
    await rm(join(projectRoot!, "sub"), { recursive: true, force: true });

    const { out, err } = await runPull();

    expect(err).toBeUndefined();
    for (const rel of tracked) {
      expect(await readFile(join(projectRoot!, rel), "utf8")).toBe(
        await readFile(remotePathOf("clone", rel), "utf8"),
      );
    }
    expect(out).toMatch(/\.env — restored/);
    expect(out).toMatch(/sub\/app\.local\.json — restored/);
    expect(out).toContain("Summary: 2 restored");
    // Restoring counts as syncing — the registry learns about this machine.
    expect((await readGlobalConfig(homeDir)).projects).toHaveLength(1);
  });

  it("reports files with no remote copy clearly (deleted on backend) without crashing", async () => {
    await makeProject("gone", [".env", "steady.txt"], [".env", "steady.txt"]);
    // .env was deleted on the backend (index entry + file gone);
    // steady.txt changed remotely.
    const index = JSON.parse(await readFile(indexPathOf("gone"), "utf8")) as {
      files: Record<string, unknown>;
    };
    delete index.files[".env"];
    await rm(remotePathOf("gone", ".env"));
    await writeFile(indexPathOf("gone"), JSON.stringify(index, null, 2) + "\n");
    await setRemoteContent("gone", "steady.txt", "remotely edited\n");

    const { out, err } = await runPull();

    // Reported clearly, NOT a crash and not even a failure exit. Local
    // copies are never deleted by pull.
    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — skipped \(no remote copy/);
    expect(out).toMatch(/steady\.txt — pulled/);
    expect(out).toContain("Summary: 1 pulled, 1 skipped (not on remote)");
    expect(await readFile(join(projectRoot!, ".env"), "utf8")).toBe("A=1\nB=2\n");
  });

  it("skips a tracked file that exists nowhere (no local copy, no remote copy)", async () => {
    await makeProject("vanished", [".env", "steady.txt"]);
    await rm(join(projectRoot!, ".env"));

    const { out, err } = await runPull();

    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — skipped \(no local copy, no remote copy\)/);
    // Never pushed → steady.txt is simply not on the remote either.
    expect(out).toMatch(/steady\.txt — skipped \(no remote copy/);
  });

  it("asks for confirmation and aborts cleanly when declined (nothing downloads)", async () => {
    await makeProject("confirm-no", [".env"], [".env"]);
    await setRemoteContent("confirm-no", ".env", "REMOTE=1\n");
    const localBefore = await readFile(join(projectRoot!, ".env"), "utf8");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    q.answers = [false];

    const { out, err } = await runPull();

    expect(err).toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    expect(out).toContain("Download (OVERWRITE the local file — remote wins):");
    expect(out).toContain("Aborted — nothing was pulled.");
    expect(await readFile(join(projectRoot!, ".env"), "utf8")).toBe(localBefore);
  });

  it("partial failure: a failed download leaves the failed file untouched, others pulled", async () => {
    await makeProject("partial", [".env", "blocked/inner.txt"], [".env", "blocked/inner.txt"]);
    // .env changed remotely (should pull). For blocked/inner.txt: delete the
    // local copy AND park a plain FILE at its parent-dir path — the local
    // mkdir in backend.pull then fails (EEXIST on POSIX, EPERM on Windows),
    // a genuine per-file backend error with no mocks involved.
    await setRemoteContent("partial", ".env", "A=42\nB=2\n");
    await rm(join(projectRoot!, "blocked"), { recursive: true, force: true });
    await writeFile(join(projectRoot!, "blocked"), "not a directory\n");

    const { out, err } = await runPull();

    expect(errMsg(err)).toMatch(/Pull incomplete — 1 failed to download/);
    expect(out).toMatch(/\.env — pulled/);
    expect(out).toMatch(/blocked\/inner\.txt — FAILED \(/);
    // The remote copies are intact regardless of the local failure.
    expect(await readFile(remotePathOf("partial", "blocked/inner.txt"), "utf8")).toBe(
      "inner content\n",
    );
  });

  it("handles a project with zero tracked files", async () => {
    await makeProject("empty", []);
    const { out, err } = await runPull();
    expect(err).toBeUndefined();
    expect(out).toContain("Project 'empty' (backend: local-fs) — 0 tracked file(s)");
    expect(out).toContain("No tracked files yet — use `vsync add <path>` or re-run `vsync init`.");
  });

  it("requires an initialized project", async () => {
    const bare = await mkdtemp(join(tmpdir(), "vsync-pull-bare-"));
    try {
      await expect(runPullCommand(bare, false)).rejects.toThrow(/`vsync init`/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("vsync pull --json", () => {
  it("emits one result object with per-file outcomes", async () => {
    await makeProject("json-clean", [".env", "steady.txt"], [".env", "steady.txt"]);
    await setRemoteContent("json-clean", ".env", "REMOTE=1\n");

    const { out, err } = await runPull(false, "json");

    expect(err).toBeUndefined();
    const parsed = JSON.parse(out) as {
      projectId: string;
      files: { path: string; outcome: string; note?: string }[];
      summary: Record<string, number>;
    };
    expect(parsed.projectId).toBe("json-clean");
    expect(parsed.files).toEqual(
      expect.arrayContaining([
        { path: ".env", outcome: "pulled" },
        { path: "steady.txt", outcome: "skipped-unchanged" },
      ]),
    );
    expect(parsed.summary).toEqual({ pulled: 1, "skipped-unchanged": 1 });
    expect(out.trim().startsWith("{")).toBe(true);
    expect(out).not.toContain("tracked file(s)");
  });

  it("prints the result BEFORE throwing on an incomplete pull", async () => {
    await makeProject("json-fail", [".env", "blocked/inner.txt"], [".env", "blocked/inner.txt"]);
    await rm(join(projectRoot!, "blocked"), { recursive: true, force: true });
    await writeFile(join(projectRoot!, "blocked"), "not a directory\n");

    const { out, err } = await runPull(false, "json");

    expect(err).toBeInstanceOf(Error);
    expect(errMsg(err)).toMatch(/Pull incomplete/);
    const parsed = JSON.parse(out) as { files: { outcome: string }[] };
    expect(parsed.files.some((f) => f.outcome === "failed")).toBe(true);
  });
});
