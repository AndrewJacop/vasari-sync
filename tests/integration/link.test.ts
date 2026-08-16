import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `vsync link` integration: machine A pushes, machine B is a fresh clone
 * (git repo, no .vsync) that rebuilds its manifest from the backend and
 * pulls. All prompts scripted like the other command tests.
 */
const q = vi.hoisted(() => ({ answers: [] as unknown[] }));
vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(async () => q.answers.shift()),
  select: vi.fn(async () => q.answers.shift()),
  input: vi.fn(async () => q.answers.shift()),
  checkbox: vi.fn(async () => q.answers.shift()),
  password: vi.fn(async () => q.answers.shift()),
}));

/**
 * Regression guard for the link crash: handlers must receive profile
 * settings MERGED with that backend's secrets — a github-repo profile's
 * settings carry no token (it lives in the secret store), and the handler
 * constructor rejects a token-less config before any listing.
 */
vi.mock("../../src/storage/handlers/github-repo.js", () => {
  class FakeGithubRepoHandler {
    static lastConfig: unknown;
    static listedPrefix: string | null = null;
    constructor(config: unknown) {
      FakeGithubRepoHandler.lastConfig = config;
    }
    async list(prefix?: string) {
      FakeGithubRepoHandler.listedPrefix = prefix ?? null;
      return [{ path: "my-app/.env", size: 3, etagOrHash: "sha256:abc" }];
    }
    async pull() {
      /* not exercised — pull is declined in this test */
    }
  }
  return { GithubRepoHandler: FakeGithubRepoHandler };
});

import { runLinkCommand } from "../../src/commands/link.js";
import { readManifest } from "../../src/core/manifest.js";
import { readGlobalConfig } from "../../src/core/globalConfig.js";
import { GithubRepoHandler } from "../../src/storage/handlers/github-repo.js";
import { remoteKeyFor } from "../../src/utils/paths.js";

const execFileAsync = promisify(execFile);

/** Machine A: project dir + global profile + remote tree with pushed files. */
let homeDir: string;
let remoteDir: string;
const machineA: { root: string; id: string; files: Record<string, string> } = {
  root: "",
  id: "my-app",
  files: { ".env": "A=1\nB=2\n", "local-notes.txt": "just some notes\n" },
};

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  homeDir = await mkdtemp(join(tmpdir(), "vsync-link-home-"));
  remoteDir = await mkdtemp(join(tmpdir(), "vsync-link-remote-"));
  machineA.root = await mkdtemp(join(tmpdir(), "vsync-link-a-"));
  await execFileAsync("git", ["init", "-q"], { cwd: machineA.root });

  for (const [rel, content] of Object.entries(machineA.files)) {
    const abs = join(machineA.root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    const dest = join(remoteDir, remoteKeyFor(machineA.id, rel));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(abs, dest);
  }

  await mkdir(join(homeDir, ".vsync"), { recursive: true });
  await writeFile(
    join(homeDir, ".vsync", "config.json"),
    JSON.stringify({
      profiles: { "local-fs": { backend: "local-fs", settings: { basePath: remoteDir } } },
      secrets: {},
      projects: [],
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [homeDir, remoteDir, machineA.root].map((d) => rm(d, { recursive: true, force: true })),
  );
});

/** Machine B: a fresh git clone — tracked files absent, no .vsync dir. */
async function freshClone(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vsync-link-b-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  return root;
}

describe("vsync link", () => {
  it("rebuilds the manifest from the backend and pulls into a fresh clone", async () => {
    const clone = await freshClone();
    q.answers = [true /* pull now? */];

    await runLinkCommand(clone, machineA.id, homeDir);

    // Manifest rebuilt from the backend listing — paths, no stale hashes.
    const manifest = await readManifest(clone);
    expect(manifest?.projectId).toBe(machineA.id);
    expect(manifest?.backend).toBe("local-fs");
    expect(manifest?.files.map((f) => f.path).sort()).toEqual([".env", "local-notes.txt"]);

    // Pull ran: file contents match machine A's.
    expect(await readFile(join(clone, ".env"), "utf8")).toBe(machineA.files[".env"]);
    expect(await readFile(join(clone, "local-notes.txt"), "utf8")).toBe(
      machineA.files["local-notes.txt"],
    );
    // Pull stamped real sync state over link's placeholders.
    const pulled = (await readManifest(clone))!.files;
    expect(pulled.every((f) => f.hash.startsWith("sha256:") && f.lastSyncedHash)).toBe(true);

    // Registered globally, so `vsync list` sees it on machine B.
    const global = await readGlobalConfig(homeDir);
    expect(global.projects).toEqual([
      expect.objectContaining({ projectId: machineA.id, path: clone, backend: "local-fs" }),
    ]);

    // The manifest is kept out of git: .gitignore carries .vsync/.
    expect(await readFile(join(clone, ".gitignore"), "utf8")).toContain(".vsync/");
  });

  it("skips the pull when declined — manifest still rebuilt, no files written", async () => {
    const clone = await freshClone();
    q.answers = [false /* pull now? */];

    await runLinkCommand(clone, machineA.id, homeDir);

    expect((await readManifest(clone))?.files).toHaveLength(2);
    await expect(stat(join(clone, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to clobber an existing manifest", async () => {
    const clone = await freshClone();
    await mkdir(join(clone, ".vsync"), { recursive: true });
    await writeFile(join(clone, ".vsync", "manifest.json"), "{}");

    await expect(runLinkCommand(clone, machineA.id, homeDir)).rejects.toThrow(
      /already has a .vsync\/manifest.json/,
    );
  });

  it("errors clearly for a project no backend knows", async () => {
    const clone = await freshClone();
    await expect(runLinkCommand(clone, "no-such-project", homeDir)).rejects.toThrow(
      /No files found for project 'no-such-project'.*local-fs/,
    );
  });

  it("errors when no backend profiles are configured", async () => {
    const clone = await freshClone();
    await writeFile(join(homeDir, ".vsync", "config.json"), JSON.stringify({ profiles: {} }));
    await expect(runLinkCommand(clone, machineA.id, homeDir)).rejects.toThrow(
      /No configured backend profiles/,
    );
  });

  it("merges each profile's secrets into the handler config (link crash regression)", async () => {
    await writeFile(
      join(homeDir, ".vsync", "config.json"),
      JSON.stringify({
        profiles: {
          "github-repo": { backend: "github-repo", settings: { owner: "octocat", repo: "vault" } },
        },
        secrets: { "github-repo/token": "ghp_secret_token" },
        projects: [],
      }),
    );
    const clone = await freshClone();
    q.answers = [false /* pull now? */];

    await runLinkCommand(clone, "my-app", homeDir);

    const Fake = GithubRepoHandler as unknown as {
      lastConfig: unknown;
      listedPrefix: string | null;
    };
    // Settings AND secret token reached the handler — without the merge,
    // its constructor throws "missing required settings: token".
    expect(Fake.lastConfig).toEqual({
      owner: "octocat",
      repo: "vault",
      token: "ghp_secret_token",
    });
    expect(Fake.listedPrefix).toBe("my-app/");
    // The fake listing became a manifest entry.
    expect((await readManifest(clone))?.files.map((f) => f.path)).toEqual([".env"]);
  });
});
