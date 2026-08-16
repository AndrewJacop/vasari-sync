import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPushCommand } from "../../src/commands/push.js";
import { readGlobalConfig } from "../../src/core/globalConfig.js";
import { hashFile } from "../../src/core/hash.js";
import {
  manifestPath,
  readManifest,
  writeManifest,
  type ManifestFileEntry,
} from "../../src/core/manifest.js";
import { remoteKeyFor } from "../../src/utils/paths.js";

const execFileAsync = promisify(execFile);

let projectRoot: string | undefined;
let homeDir: string | undefined;
let remoteDir: string | undefined;

/**
 * A real git project the way `vsync init` leaves it, backed by a local-fs
 * backend. Tracked files start UNSYNCED unless `pushed` names them — for
 * those, the file is copied to the remote tree and the manifest entry gets
 * lastSyncedHash/lastSyncedAt stamped, exactly what a successful `push`
 * does.
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

/** Drives push with console captured; `err` holds a thrown aggregate (if
 * any) instead of letting it escape — tests decide what to expect. */
async function runPush(force = false): Promise<{ out: string; warns: string[]; err?: unknown }> {
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
    await runPushCommand(projectRoot!, force, homeDir);
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

describe("vsync push", () => {
  it("clean push of new (never-pushed) files uploads, stamps the manifest, and registers the project", async () => {
    const tracked = [".env", "local-notes.txt", "sub/app.local.json"];
    await makeProject("clean", tracked);

    const { out, err } = await runPush();

    expect(err).toBeUndefined();
    for (const rel of tracked) {
      // Remote copy exists and matches local content exactly.
      expect(await readFile(remotePathOf("clean", rel), "utf8")).toBe(
        await readFile(join(projectRoot!, rel), "utf8"),
      );
      // Manifest stamped with the pushed content's hash.
      const entry = (await readManifest(projectRoot!))!.files.find((f) => f.path === rel)!;
      expect(entry.lastSyncedHash).toBe(await hashFile(join(projectRoot!, rel)));
      expect(entry.lastSyncedAt).toBeTruthy();
      expect(out).toMatch(new RegExp(`${rel.replace(/\//g, "\\/")} — pushed`));
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

  it("is a no-op on unchanged files — nothing re-uploaded, manifest byte-identical", async () => {
    await makeProject("noop", [".env", "steady.txt"]);
    const first = await runPush();
    expect(first.err).toBeUndefined();
    const manifestAfterFirst = await readFile(manifestPath(projectRoot!), "utf8");

    const second = await runPush();

    expect(second.err).toBeUndefined();
    expect(second.out).toMatch(/\.env — skipped \(unchanged\)/);
    expect(second.out).toMatch(/steady\.txt — skipped \(unchanged\)/);
    expect(second.out).toContain("Summary: 2 skipped (unchanged)");
    // No-op writes nothing: manifest content (incl. lastSyncedAt) identical.
    expect(await readFile(manifestPath(projectRoot!), "utf8")).toBe(manifestAfterFirst);
  });

  it("refuses a conflict (both sides changed) without --force — remote untouched, manifest untouched", async () => {
    await makeProject("conflict", [".env"], [".env"]);
    const baseHash = (await readManifest(projectRoot!))!.files[0].lastSyncedHash;
    await writeFile(join(projectRoot!, ".env"), "A=99\n"); // local side changes
    await writeFile(remotePathOf("conflict", ".env"), "REMOTE=1\n"); // remote side changes

    const { out, err } = await runPush();

    expect(errMsg(err)).toMatch(/Push incomplete — 1 conflicted \(needs --force\)/);
    expect(out).toMatch(/\.env — REFUSED \(conflict/);
    // Remote keeps the OTHER machine's version; manifest keeps the base hash.
    expect(await readFile(remotePathOf("conflict", ".env"), "utf8")).toBe("REMOTE=1\n");
    expect((await readManifest(projectRoot!))!.files[0].lastSyncedHash).toBe(baseHash);
  });

  it("refuses to clobber a remotely-modified file without --force (nothing gained by pushing)", async () => {
    await makeProject("needspull", [".env"], [".env"]);
    const baseHash = (await readManifest(projectRoot!))!.files[0].lastSyncedHash;
    await writeFile(remotePathOf("needspull", ".env"), "REMOTE=2\n"); // remote-only change

    const { out, err } = await runPush();

    expect(errMsg(err)).toMatch(/Push incomplete — 1 changed remotely/);
    expect(out).toMatch(/\.env — REFUSED \(changed remotely only/);
    expect(await readFile(remotePathOf("needspull", ".env"), "utf8")).toBe("REMOTE=2\n");
    expect((await readManifest(projectRoot!))!.files[0].lastSyncedHash).toBe(baseHash);
  });

  it("--force warns loudly, then overwrites the remote copy with the local version", async () => {
    await makeProject("forced", [".env"], [".env"]);
    await writeFile(join(projectRoot!, ".env"), "A=99\n");
    await writeFile(remotePathOf("forced", ".env"), "REMOTE=1\n");

    const { out, warns, err } = await runPush(true);

    expect(err).toBeUndefined();
    // The warning fires BEFORE anything uploads and names the cost.
    expect(warns.join("\n")).toMatch(/WARNING: --force overwrites the remote copy/);
    expect(warns.join("\n")).toMatch(/will be LOST: \.env/);
    expect(out).toMatch(/\.env — pushed/);
    // Local version won; manifest stamped with its hash.
    expect(await readFile(remotePathOf("forced", ".env"), "utf8")).toBe("A=99\n");
    const entry = (await readManifest(projectRoot!))!.files[0];
    expect(entry.lastSyncedHash).toBe(await hashFile(join(projectRoot!, ".env")));
  });

  it("partial failure: a failed upload leaves successful files stamped and the failed one untouched", async () => {
    await makeProject("partial", [".env", "steady.txt"]);
    // Sink the backend call for steady.txt: a DIRECTORY at its remote
    // destination makes copyFile fail (EISDIR on POSIX, EPERM on Windows),
    // and list() can't see it as a file either — a genuine backend error.
    await mkdir(remotePathOf("partial", "steady.txt"), { recursive: true });

    const { out, err } = await runPush();

    expect(errMsg(err)).toMatch(/Push incomplete — 1 failed to upload/);
    expect(out).toMatch(/\.env — pushed/);
    expect(out).toMatch(/steady\.txt — FAILED \(/);
    // Per-file manifest accuracy, not all-or-nothing.
    const manifest = (await readManifest(projectRoot!))!;
    const envEntry = manifest.files.find((f) => f.path === ".env")!;
    const steadyEntry = manifest.files.find((f) => f.path === "steady.txt")!;
    expect(envEntry.lastSyncedHash).toBe(await hashFile(join(projectRoot!, ".env")));
    expect(steadyEntry.lastSyncedHash).toBeUndefined();
    // .env really made it to the backend despite steady.txt failing.
    expect(await readFile(remotePathOf("partial", ".env"), "utf8")).toBe("A=1\nB=2\n");
  });

  it("reports a tracked file that's missing locally, still pushes the others", async () => {
    await makeProject("gone", [".env", "steady.txt"]);
    await rm(join(projectRoot!, ".env"));

    const { out, err } = await runPush();

    expect(err).toBeUndefined(); // reported, not a failure
    expect(out).toMatch(/\.env — skipped \(no local file\)/);
    expect(out).toMatch(/steady\.txt — pushed/);
    expect(out).toContain("Summary: 1 pushed, 1 skipped (no local file)");
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
