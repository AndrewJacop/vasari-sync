import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPullCommand } from "../../src/commands/pull.js";
import { readGlobalConfig } from "../../src/core/globalConfig.js";
import { hashFile } from "../../src/core/hash.js";
import {
  manifestPath,
  readManifest,
  writeManifest,
  type ManifestFileEntry,
} from "../../src/core/manifest.js";
import { writeProjectConfig } from "../../src/core/projectConfig.js";
import { remoteKeyFor } from "../../src/utils/paths.js";

const execFileAsync = promisify(execFile);

let projectRoot: string | undefined;
let homeDir: string | undefined;
let remoteDir: string | undefined;

const DEFAULT_CONTENTS: Record<string, string> = {
  ".env": "A=1\nB=2\n",
  "local-notes.txt": "just some notes\n",
  "steady.txt": "steady as she goes\n",
  "sub/app.local.json": '{ "debug": true }\n',
  "blocked/inner.txt": "inner content\n",
  "fresh.txt": "fresh and never pushed\n",
};

/**
 * A real git project the way `vsync init` + a successful `push` leaves it,
 * backed by a local-fs backend. `pushed` files are copied to the remote
 * tree and their manifest entries get lastSyncedHash/lastSyncedAt stamped
 * — exactly the state a pull starts from.
 */
async function makeProject(
  name: string,
  tracked: string[],
  pushed: string[] = [],
  contents: Record<string, string> = {},
): Promise<void> {
  projectRoot = await mkdtemp(join(tmpdir(), `vsync-pull-${name}-`));
  homeDir = await mkdtemp(join(tmpdir(), `vsync-pull-${name}-home-`));
  remoteDir = await mkdtemp(join(tmpdir(), `vsync-pull-${name}-remote-`));

  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  await writeFile(join(projectRoot, ".gitignore"), ".env*\nlocal-notes.txt\nsteady.txt\n");

  const fileContents = { ...DEFAULT_CONTENTS, ...contents };
  for (const rel of tracked) {
    const abs = join(projectRoot, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, fileContents[rel]);
  }

  await writeProjectConfig(projectRoot, {
    projectId: name,
    backend: "local-fs",
    settings: { basePath: remoteDir },
  });
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

/** Remote-side location of a tracked file — always via remoteKeyFor, never
 * a hand-joined projectId (a wrong ID is exactly how fixtures rot). */
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

/** Drives pull with console captured; `err` holds a thrown aggregate (if
 * any) instead of letting it escape — tests decide what to expect. */
async function runPull(force = false): Promise<{ out: string; warns: string[]; err?: unknown }> {
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
    await runPullCommand(projectRoot!, force, homeDir);
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of [projectRoot, homeDir, remoteDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  projectRoot = homeDir = remoteDir = undefined;
});

describe("vsync pull", () => {
  it("clean pull of remotely-changed files downloads them, stamps the manifest, and registers the project", async () => {
    const tracked = [".env", "local-notes.txt", "sub/app.local.json"];
    await makeProject("clean", tracked, tracked);
    // The other machine changed all three remote copies.
    await writeFile(remotePathOf("clean", ".env"), "A=42\nB=2\n");
    await writeFile(remotePathOf("clean", "local-notes.txt"), "remotely edited notes\n");
    await writeFile(remotePathOf("clean", "sub/app.local.json"), '{ "debug": false }\n');

    const { out, err } = await runPull();

    expect(err).toBeUndefined();
    for (const rel of tracked) {
      // Local copy now equals the remote version exactly.
      expect(await readFile(join(projectRoot!, rel), "utf8")).toBe(
        await readFile(remotePathOf("clean", rel), "utf8"),
      );
      // Manifest stamped with the pulled content's hash.
      const entry = (await readManifest(projectRoot!))!.files.find((f) => f.path === rel)!;
      expect(entry.lastSyncedHash).toBe(await hashFile(join(projectRoot!, rel)));
      expect(entry.lastSyncedAt).toBeTruthy();
      expect(out).toMatch(new RegExp(`${rel.replace(/\//g, "\\/")} — pulled`));
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
    expect(out).toContain("Summary: 3 pulled");
  });

  it("is a no-op on unchanged files — nothing re-downloaded, manifest byte-identical", async () => {
    await makeProject("noop", [".env", "steady.txt"], [".env", "steady.txt"]);
    const manifestBefore = await readFile(manifestPath(projectRoot!), "utf8");

    const { out, err } = await runPull();

    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — skipped \(unchanged\)/);
    expect(out).toMatch(/steady\.txt — skipped \(unchanged\)/);
    expect(out).toContain("Summary: 2 skipped (unchanged)");
    // No-op writes nothing: manifest content (incl. lastSyncedAt) identical.
    expect(await readFile(manifestPath(projectRoot!), "utf8")).toBe(manifestBefore);
    // Nothing pulled → the registry isn't touched either.
    expect((await readGlobalConfig(homeDir)).projects).toHaveLength(0);
  });

  it("refuses a conflict (both sides changed) without --force — local and remote untouched", async () => {
    await makeProject("conflict", [".env"], [".env"]);
    const baseHash = (await readManifest(projectRoot!))!.files[0].lastSyncedHash;
    await writeFile(join(projectRoot!, ".env"), "A=99\n"); // local side changes
    await writeFile(remotePathOf("conflict", ".env"), "REMOTE=1\n"); // remote side changes

    const { out, err } = await runPull();

    expect(errMsg(err)).toMatch(/Pull incomplete — 1 conflicted \(needs --force\)/);
    expect(out).toMatch(/\.env — REFUSED \(conflict/);
    // Each side keeps its own version; manifest keeps the base hash.
    expect(await readFile(join(projectRoot!, ".env"), "utf8")).toBe("A=99\n");
    expect(await readFile(remotePathOf("conflict", ".env"), "utf8")).toBe("REMOTE=1\n");
    expect((await readManifest(projectRoot!))!.files[0].lastSyncedHash).toBe(baseHash);
  });

  it("refuses to clobber a locally-modified file without --force (nothing gained by pulling)", async () => {
    await makeProject("needspush", [".env"], [".env"]);
    const baseHash = (await readManifest(projectRoot!))!.files[0].lastSyncedHash;
    await writeFile(join(projectRoot!, ".env"), "A=99\n"); // local-only change

    const { out, err } = await runPull();

    expect(errMsg(err)).toMatch(/Pull incomplete — 1 changed locally/);
    expect(out).toMatch(/\.env — REFUSED \(changed locally only/);
    // Local edits survive; manifest keeps the base hash.
    expect(await readFile(join(projectRoot!, ".env"), "utf8")).toBe("A=99\n");
    expect((await readManifest(projectRoot!))!.files[0].lastSyncedHash).toBe(baseHash);
  });

  it("--force warns loudly, then overwrites the local copy with the remote version", async () => {
    await makeProject("forced", [".env"], [".env"]);
    await writeFile(join(projectRoot!, ".env"), "A=99\n");
    await writeFile(remotePathOf("forced", ".env"), "REMOTE=1\n");

    const { out, warns, err } = await runPull(true);

    expect(err).toBeUndefined();
    // The warning fires BEFORE anything downloads and names the cost.
    expect(warns.join("\n")).toMatch(/WARNING: --force overwrites your LOCAL file/);
    expect(warns.join("\n")).toMatch(/will be LOST: \.env/);
    expect(out).toMatch(/\.env — pulled/);
    // Remote version won; manifest stamped with its hash.
    expect(await readFile(join(projectRoot!, ".env"), "utf8")).toBe("REMOTE=1\n");
    const entry = (await readManifest(projectRoot!))!.files[0];
    expect(entry.lastSyncedHash).toBe(await hashFile(join(projectRoot!, ".env")));
  });

  it("restores a locally-missing file from the backend (fresh-clone / deleted-locally case)", async () => {
    const tracked = [".env", "sub/app.local.json"];
    await makeProject("clone", tracked, tracked);
    // Simulate machine B: manifest via git, tracked files absent locally.
    await rm(join(projectRoot!, ".env"));
    await rm(join(projectRoot!, "sub"), { recursive: true, force: true });

    const { out, err } = await runPull();

    expect(err).toBeUndefined();
    for (const rel of tracked) {
      expect(await readFile(join(projectRoot!, rel), "utf8")).toBe(
        await readFile(remotePathOf("clone", rel), "utf8"),
      );
      const entry = (await readManifest(projectRoot!))!.files.find((f) => f.path === rel)!;
      expect(entry.lastSyncedHash).toBe(await hashFile(join(projectRoot!, rel)));
    }
    expect(out).toMatch(/\.env — pulled \(restored\)/);
    expect(out).toMatch(/sub\/app\.local\.json — pulled \(restored\)/);
    expect(out).toContain("Summary: 2 pulled");
    // Restoring counts as syncing — the registry learns about this machine.
    expect((await readGlobalConfig(homeDir)).projects).toHaveLength(1);
  });

  it("reports a remotely-missing file clearly (deleted on the backend) without crashing, still pulls others", async () => {
    await makeProject("gone", [".env", "steady.txt", "fresh.txt"], [".env", "steady.txt"]);
    // .env was deleted on the backend by another machine; fresh.txt was
    // never pushed at all; steady.txt's remote copy changed.
    await unlink(remotePathOf("gone", ".env"));
    await writeFile(remotePathOf("gone", "steady.txt"), "remotely edited\n");

    const { out, err } = await runPull();

    // Reported clearly, NOT a crash and not even a failure exit.
    expect(err).toBeUndefined();
    expect(out).toMatch(/\.env — skipped \(no remote copy\) \(deleted on the backend/);
    expect(out).toMatch(/fresh\.txt — skipped \(no remote copy\) \(never pushed\)/);
    expect(out).toMatch(/steady\.txt — pulled/);
    expect(out).toContain("Summary: 1 pulled, 2 skipped (no remote copy)");
    // Local copies untouched by the reports.
    expect(await readFile(join(projectRoot!, ".env"), "utf8")).toBe("A=1\nB=2\n");
    expect(await readFile(join(projectRoot!, "fresh.txt"), "utf8")).toBe(
      "fresh and never pushed\n",
    );
  });

  it("partial failure: a failed download leaves successful files stamped and the failed one untouched", async () => {
    await makeProject("partial", [".env", "blocked/inner.txt"], [".env", "blocked/inner.txt"]);
    const innerBase = (await readManifest(projectRoot!))!.files.find(
      (f) => f.path === "blocked/inner.txt",
    )!.lastSyncedHash;
    // .env changed remotely (should pull). For blocked/inner.txt: delete the
    // local copy AND park a plain FILE at its parent-dir path — the local
    // mkdir in backend.pull then fails (EEXIST on POSIX, EPERM on Windows),
    // a genuine per-file backend error with no mocks involved.
    await writeFile(remotePathOf("partial", ".env"), "A=42\nB=2\n");
    await rm(join(projectRoot!, "blocked"), { recursive: true, force: true });
    await writeFile(join(projectRoot!, "blocked"), "not a directory\n");

    const { out, err } = await runPull();

    expect(errMsg(err)).toMatch(/Pull incomplete — 1 failed to download/);
    expect(out).toMatch(/\.env — pulled/);
    expect(out).toMatch(/blocked\/inner\.txt — FAILED \(/);
    // Per-file manifest accuracy, not all-or-nothing.
    const manifest = (await readManifest(projectRoot!))!;
    const envEntry = manifest.files.find((f) => f.path === ".env")!;
    const innerEntry = manifest.files.find((f) => f.path === "blocked/inner.txt")!;
    expect(envEntry.lastSyncedHash).toBe(await hashFile(join(projectRoot!, ".env")));
    expect(innerEntry.lastSyncedHash).toBe(innerBase);
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
