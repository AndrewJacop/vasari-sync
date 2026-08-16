import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scripted prompt queue: every prompt pops the next scripted answer, in the
 * order the command asks them (select → per-field prompts in BACKEND_FIELDS
 * order → optional save-anyway confirm).
 */
const q = vi.hoisted(() => ({ answers: [] as unknown[] }));

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async () => q.answers.shift()),
  input: vi.fn(async () => q.answers.shift()),
  password: vi.fn(async () => q.answers.shift()),
  confirm: vi.fn(async () => q.answers.shift()),
}));

/**
 * The s3 handler is mocked so the secret-bearing flow runs without network.
 * The fake records the exact merged config handed to the backend.
 */
vi.mock("../../src/storage/handlers/s3.js", () => {
  class FakeS3Handler {
    static lastConfig: unknown;
    constructor(config: unknown) {
      FakeS3Handler.lastConfig = config;
    }
    async testConnection() {
      return { ok: true, message: "fake s3" } as const;
    }
  }
  return { S3Handler: FakeS3Handler };
});

vi.mock("../../src/utils/gh.js", () => ({ ghAuth: vi.fn(async () => ({})) }));

vi.mock("../../src/storage/handlers/github-repo.js", () => {
  class FakeGithubRepoHandler {
    static lastConfig: unknown;
    /** Flip to true to make the next testConnection fail (token/scope case). */
    static failNext = false;
    constructor(config: unknown) {
      FakeGithubRepoHandler.lastConfig = config;
    }
    async testConnection() {
      if (FakeGithubRepoHandler.failNext) {
        FakeGithubRepoHandler.failNext = false;
        return { ok: false, message: "cannot access octocat/vasari-sync" } as const;
      }
      return { ok: true, message: "fake github" } as const;
    }
  }
  return { GithubRepoHandler: FakeGithubRepoHandler };
});

import { confirm, input } from "@inquirer/prompts";
import { S3Handler } from "../../src/storage/handlers/s3.js";
import { GithubRepoHandler } from "../../src/storage/handlers/github-repo.js";
import { ghAuth } from "../../src/utils/gh.js";
import { runConfigCommand } from "../../src/commands/config.js";
import { readGlobalConfig } from "../../src/core/globalConfig.js";

function script(...answers: unknown[]): void {
  q.answers = answers;
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "vsync-config-home-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

const FakeS3 = S3Handler as unknown as { lastConfig: unknown };
const FakeGithubRepo = GithubRepoHandler as unknown as { lastConfig: unknown };

describe("vsync config — interactive local-fs flow (scripted prompts)", () => {
  it("prompts for the backend, tests the connection, and saves the profile", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "vsync-config-remote-"));
    script("local-fs", storageDir);

    await runConfigCommand({}, home);

    const config = await readGlobalConfig(home);
    expect(config.defaultBackend).toBe("local-fs");
    expect(config.profiles["local-fs"]).toEqual({
      backend: "local-fs",
      settings: { basePath: storageDir },
    });
    // local-fs has no secret fields: nothing in the secret store, no warning.
    expect(config.secrets).toEqual({});
    expect(config.secretsFallbackNotified).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Connection OK"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Saved 'local-fs'"));
    await rm(storageDir, { recursive: true, force: true });
  });

  it("aborts without saving when the connection test fails and the user declines", async () => {
    const missing = join(home, "definitely", "not", "here");
    script("local-fs", missing, false /* save anyway? */);

    await runConfigCommand({}, home);

    const config = await readGlobalConfig(home);
    expect(config.profiles).toEqual({});
    expect(config.defaultBackend).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Aborted — nothing saved"));
  });

  it("saves anyway when the user overrides the failed connection test", async () => {
    const missing = join(home, "definitely", "not", "here");
    script("local-fs", missing, true /* save anyway? */);

    await runConfigCommand({}, home);

    const config = await readGlobalConfig(home);
    expect(config.profiles["local-fs"]?.settings).toEqual({ basePath: missing });
    // The failed test must surface to the user (it is the confirm prompt's
    // message, rendered by inquirer — not a console.log line).
    expect(vi.mocked(confirm)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Connection test failed") }),
    );
  });
});

describe("vsync config — secret handling (s3 via mocked handler)", () => {
  it("keeps secrets out of profile settings, stores them in the secret store", async () => {
    script(
      "s3",
      "us-east-1", // region
      "my-bucket", // bucket
      "", // endpoint (optional, blank → omitted)
      "AKIAEXAMPLE", // accessKeyId (secret)
      "super-secret-value", // secretAccessKey (secret)
      false, // forcePathStyle
    );

    await runConfigCommand({}, home);

    const config = await readGlobalConfig(home);
    expect(config.defaultBackend).toBe("s3");
    // Non-secret settings only — no credential fields present at all.
    expect(config.profiles["s3"]).toEqual({
      backend: "s3",
      settings: { region: "us-east-1", bucket: "my-bucket", forcePathStyle: false },
    });
    expect(config.secrets["s3/accessKeyId"]).toBe("AKIAEXAMPLE");
    expect(config.secrets["s3/secretAccessKey"]).toBe("super-secret-value");
    expect(config.secretsFallbackNotified).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("0600"));

    // The backend received settings AND secrets merged.
    expect(FakeS3.lastConfig).toEqual({
      region: "us-east-1",
      bucket: "my-bucket",
      forcePathStyle: false,
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "super-secret-value",
    });
  });

  it("blank secret answers keep previously stored secrets", async () => {
    script("s3", "k1", "b1", "", "v1", "v2", true);
    await runConfigCommand({}, home);

    // Re-run: same settings, both secrets left blank.
    script("s3", "k2", "b2", "http://minio:9000", "", "", false);
    await runConfigCommand({}, home);

    const config = await readGlobalConfig(home);
    expect(config.profiles["s3"]?.settings).toEqual({
      region: "k2",
      bucket: "b2",
      endpoint: "http://minio:9000",
      forcePathStyle: false,
    });
    // Old secrets survive untouched.
    expect(config.secrets["s3/accessKeyId"]).toBe("v1");
    expect(config.secrets["s3/secretAccessKey"]).toBe("v2");
    // The backend still received the kept secrets merged with new settings.
    expect(FakeS3.lastConfig).toEqual({
      region: "k2",
      bucket: "b2",
      endpoint: "http://minio:9000",
      forcePathStyle: false,
      accessKeyId: "v1",
      secretAccessKey: "v2",
    });
  });
});

describe("vsync config — github-repo with gh CLI (scripted prompts)", () => {
  it("reuses the gh CLI token and defaults the owner to the gh login", async () => {
    vi.mocked(ghAuth).mockResolvedValue({
      token: "ghp_cli",
      login: "octocat",
      repo: "octocat/vasari-sync", // cwd repo — must NOT prefill the vault repo
    });
    // Scripted answers: the prompt mock does not apply `default`, so every
    // input gets an explicit answer in BACKEND_FIELDS order (token skipped).
    script(
      "github-repo",
      true, // use gh CLI token?
      "octocat", // owner
      "vasari-sync", // repo
      "", // branch (optional)
      "", // remoteBasePath (optional)
    );

    await runConfigCommand({}, home);

    const config = await readGlobalConfig(home);
    expect(config.profiles["github-repo"]?.settings).toEqual({
      owner: "octocat",
      repo: "vasari-sync",
    });
    expect(config.secrets["github-repo/token"]).toBe("ghp_cli");
    // No token prompt was queued, yet the backend still got one.
    expect(FakeGithubRepo.lastConfig).toEqual({
      owner: "octocat",
      repo: "vasari-sync",
      token: "ghp_cli",
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Using gh CLI token"));
    // gh prefill: owner carries the login default; the vault repo gets NO
    // cwd-repo default (it must be a deliberate choice).
    expect(vi.mocked(input)).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Storage repo owner (user or org)", default: "octocat" }),
    );
    expect(vi.mocked(input)).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Storage repo (private repo vsync commits your files into — just the name, or paste its URL)",
        default: undefined,
      }),
    );
  });

  it("falls back to the PAT prompt with a tip when no gh login exists", async () => {
    vi.mocked(ghAuth).mockResolvedValue({});
    script(
      "github-repo",
      "octocat", // owner (no gh default to prefill)
      "vasari-sync", // repo
      "", // branch (optional)
      "ghp_manual", // token — PAT prompt still fires
      "", // remoteBasePath (optional)
    );

    await runConfigCommand({}, home);

    const config = await readGlobalConfig(home);
    expect(config.secrets["github-repo/token"]).toBe("ghp_manual");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No gh CLI login found"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("gh auth login"));
  });

  it("suggests a scope fix when the gh CLI token fails the connection test", async () => {
    vi.mocked(ghAuth).mockResolvedValue({ token: "ghp_cli", login: "octocat" });
    // The backend rejects the token (e.g. missing repo scope).
    (GithubRepoHandler as unknown as { failNext: boolean }).failNext = true;
    script(
      "github-repo",
      true, // use gh CLI token?
      "octocat", // owner
      "vasari-sync", // repo
      "", // branch
      "", // remoteBasePath
      false, // save anyway? — no
    );

    await runConfigCommand({}, home);

    // The failure confirm carries the gh-specific scope hint.
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("check scopes with `gh auth status`"),
      }),
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Aborted"));
  });

  it("parses a pasted SSH/HTTPS repo URL into owner + repo", async () => {
    vi.mocked(ghAuth).mockResolvedValue({ token: "ghp_cli", login: "octocat" });
    script(
      "github-repo",
      true, // use gh CLI token?
      "octocat", // owner
      "git@github.com:AndrewJacop/temp.git", // repo — pasted URL
      "", // branch
      "", // remoteBasePath
    );

    await runConfigCommand({}, home);

    const config = await readGlobalConfig(home);
    // URL owner wins over the typed owner — it's the deliberate form.
    expect(config.profiles["github-repo"]?.settings).toEqual({
      owner: "AndrewJacop",
      repo: "temp",
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Parsed storage repo: AndrewJacop/temp"),
    );
  });
});

describe("vsync config --show", () => {
  it("prints settings and redacts every secret value", async () => {
    script("s3", "us-east-1", "my-bucket", "", "AKIAEXAMPLE", "super-secret-value", false);
    await runConfigCommand({}, home);

    vi.mocked(console.log).mockClear();
    await runConfigCommand({ show: true }, home);

    const out = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(out).toContain("Default backend: s3");
    expect(out).toContain("bucket: my-bucket");
    expect(out).toContain("accessKeyId: [redacted]");
    expect(out).toContain("secretAccessKey: [redacted]");
    // The plaintext secret must never appear in --show output.
    expect(out).not.toContain("super-secret-value");
    expect(out).not.toContain("AKIAEXAMPLE");
  });
});

describe("vsync config --set-default", () => {
  it("sets the default and warns when the backend has no profile yet", async () => {
    await runConfigCommand({ setDefault: "webdav" }, home);

    const config = await readGlobalConfig(home);
    expect(config.defaultBackend).toBe("webdav");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("No saved profile for 'webdav'"),
    );
    expect(console.log).toHaveBeenCalledWith("Default backend set to 'webdav'.");
  });

  it("rejects an unknown backend name", async () => {
    await expect(runConfigCommand({ setDefault: "nosuch" }, home)).rejects.toThrow(
      /Unknown backend 'nosuch', available:/,
    );
  });
});
