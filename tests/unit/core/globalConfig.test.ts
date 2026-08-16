import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getSecret,
  globalConfigPath,
  readGlobalConfig,
  secretKey,
  setSecret,
  upsertProjectEntry,
  writeGlobalConfig,
  type GlobalConfig,
  type ProjectRegistryEntry,
} from "../../../src/core/globalConfig.js";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "vsync-globalcfg-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function entry(
  projectId: string,
  overrides: Partial<ProjectRegistryEntry> = {},
): ProjectRegistryEntry {
  return { projectId, path: join(home, projectId), backend: "local-fs", ...overrides };
}

describe("readGlobalConfig / writeGlobalConfig", () => {
  it("returns defaults for a home with no config yet (no throw)", async () => {
    await expect(readGlobalConfig(home)).resolves.toEqual({
      profiles: {},
      secrets: {},
      projects: [],
    });
  });

  it("creates ~/.vsync/config.json on first write and round-trips", async () => {
    const config: GlobalConfig = {
      defaultBackend: "s3",
      profiles: {
        main: { backend: "s3", settings: { bucket: "my-bucket", region: "us-east-1" } },
      },
      secrets: { "main/secretAccessKey": "hunter2" },
      projects: [entry("proj-a")],
    };
    await writeGlobalConfig(config, home);

    const raw = await readFile(globalConfigPath(home), "utf8");
    expect(raw).toContain('"defaultBackend": "s3"');
    expect(raw.endsWith("\n")).toBe(true);
    await expect(readGlobalConfig(home)).resolves.toEqual(config);
  });

  it("backfills missing collections when reading a partial/hand-written config", async () => {
    await writeFile(globalConfigPath(home), JSON.stringify({ defaultBackend: "webdav" }), "utf8");
    await expect(readGlobalConfig(home)).resolves.toEqual({
      defaultBackend: "webdav",
      profiles: {},
      secrets: {},
      projects: [],
    });
  });

  it("prefers explicit homeDir over VSYNC_HOME, VSYNC_HOME over real home", () => {
    process.env.VSYNC_HOME = join(home, "envhome");
    try {
      expect(globalConfigPath()).toBe(join(home, "envhome", ".vsync", "config.json"));
      expect(globalConfigPath(home)).toBe(join(home, ".vsync", "config.json"));
    } finally {
      delete process.env.VSYNC_HOME;
    }
  });

  it("sets 0600 permissions on write (POSIX only — skipped on Windows)", async () => {
    if (process.platform === "win32") return;
    const config = await readGlobalConfig(home);
    await writeGlobalConfig(config, home);
    const mode = (await stat(globalConfigPath(home))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("fails loudly on a corrupt config instead of silently resetting", async () => {
    await writeFile(globalConfigPath(home), "{ not json", "utf8");
    await expect(readGlobalConfig(home)).rejects.toThrow(/Corrupt global config/);
    // Leave a clean slate for the suites below.
    await rm(globalConfigPath(home), { force: true });
  });

  it("propagates non-ENOENT read errors (config path occupied by a directory)", async () => {
    const target = globalConfigPath(home);
    await mkdir(target, { recursive: true });
    await expect(readGlobalConfig(home)).rejects.toThrow(); // any rejection = error surfaced, not swallowed
    await rm(target, { recursive: true, force: true });
  });
});

describe("project registry (add / update / list)", () => {
  it("add: upsert appends new entries and persists them", async () => {
    const config = await readGlobalConfig(home); // defaults after cleanup above
    upsertProjectEntry(config, entry("proj-a"));
    upsertProjectEntry(config, entry("proj-b", { backend: "sftp" }));
    await writeGlobalConfig(config, home);

    const back = await readGlobalConfig(home);
    expect(back.projects.map((p) => p.projectId)).toEqual(["proj-a", "proj-b"]);
    expect(back.projects[1].backend).toBe("sftp");
  });

  it("update: upsert with the same projectId replaces instead of duplicating", async () => {
    const config = await readGlobalConfig(home);
    upsertProjectEntry(config, entry("proj-b", { lastSyncedAt: "2026-08-15T10:22:00Z" }));
    await writeGlobalConfig(config, home);

    const back = await readGlobalConfig(home);
    expect(back.projects).toHaveLength(2);
    const projB = back.projects.filter((p) => p.projectId === "proj-b");
    expect(projB).toHaveLength(1);
    expect(projB[0].lastSyncedAt).toBe("2026-08-15T10:22:00Z");
  });

  it("list: registry reads back with every field intact", async () => {
    const back = await readGlobalConfig(home);
    const projA = back.projects.find((p) => p.projectId === "proj-a");
    expect(projA).toEqual({
      projectId: "proj-a",
      path: join(home, "proj-a"),
      backend: "local-fs",
    });
  });
});

describe("secrets (fallback store)", () => {
  it("setSecret stores under <profile>/<field>, getSecret reads it back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(secretKey("main", "password")).toBe("main/password");

    await setSecret("main", "password", "s3cret-value", home);
    await expect(getSecret("main", "password", home)).resolves.toBe("s3cret-value");
    await expect(getSecret("other", "password", home)).resolves.toBeUndefined();
  });

  it("warns about the fallback store exactly once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = await readGlobalConfig(home);
    config.secretsFallbackNotified = false;
    await writeGlobalConfig(config, home);

    await setSecret("profile-a", "token", "v1", home);
    await setSecret("profile-b", "token", "v2", home);

    expect(warn).toHaveBeenCalledTimes(1);
    const notified = await readGlobalConfig(home);
    expect(notified.secretsFallbackNotified).toBe(true);
    expect(notified.secrets["profile-a/token"]).toBe("v1");
    expect(notified.secrets["profile-b/token"]).toBe("v2");
  });
});
