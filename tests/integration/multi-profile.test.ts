import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

/**
 * Multi-profile on a shared device: two users, two --config files, one
 * machine. Exercises the real runtime path — the VSYNC_CONFIG env var the
 * `--config` flag resolves to — with homeDir left undefined on every command
 * call, so all config I/O must flow through the override. VSYNC_HOME points
 * at a scratch dir as a safety net: if the override ever stops working, the
 * default-config assertions below fail loudly before anything real is touched.
 */

import { runConfigCommand } from "../../src/commands/config.js";
import { runInitCommand } from "../../src/commands/init.js";
import { runListCommand } from "../../src/commands/list.js";
import { runPushCommand } from "../../src/commands/push.js";
import { runStatusCommand } from "../../src/commands/status.js";
import { globalConfigPath, readGlobalConfig } from "../../src/core/globalConfig.js";

let deviceHome: string;
let aliceConfig: string;
let bobConfig: string;
let aliceRemote: string;
let bobRemote: string;
let aliceClone: string;
let bobClone: string;

beforeAll(async () => {
  deviceHome = await mkdtemp(join(tmpdir(), "vsync-device-home-"));
  aliceConfig = join(deviceHome, "alice.json");
  bobConfig = join(deviceHome, "bob.json");
  aliceRemote = await mkdtemp(join(tmpdir(), "vsync-alice-remote-"));
  bobRemote = await mkdtemp(join(tmpdir(), "vsync-bob-remote-"));
  aliceClone = await mkdtemp(join(tmpdir(), "vsync-alice-clone-"));
  bobClone = await mkdtemp(join(tmpdir(), "vsync-bob-clone-"));
  process.env.VSYNC_HOME = deviceHome;
  await writeFile(join(aliceClone, ".env"), "ALICE=1\n");
  await writeFile(join(bobClone, ".env"), "BOB=1\n");
});

afterAll(async () => {
  delete process.env.VSYNC_HOME;
  delete process.env.VSYNC_CONFIG;
  await rm(deviceHome, { recursive: true, force: true });
  await rm(aliceRemote, { recursive: true, force: true });
  await rm(bobRemote, { recursive: true, force: true });
  await rm(aliceClone, { recursive: true, force: true });
  await rm(bobClone, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** What `vsync --config <file> <cmd>` reduces to for the command layer. */
function useConfigOf(file: string): void {
  process.env.VSYNC_CONFIG = file;
}

it("two users configure, init, and push through separate config files without collision", async () => {
  // ── One-time setup per user: non-interactive config into their own file ──
  useConfigOf(aliceConfig);
  await runConfigCommand({ backend: "local-fs", set: [`basePath=${aliceRemote}`] });
  const alice = await readGlobalConfig();
  expect(alice.profiles["local-fs"]?.settings).toEqual({ basePath: aliceRemote });
  expect(alice.projects).toEqual([]);

  useConfigOf(bobConfig);
  await runConfigCommand({ backend: "local-fs", set: [`basePath=${bobRemote}`] });
  const bob = await readGlobalConfig();
  expect(bob.profiles["local-fs"]?.settings).toEqual({ basePath: bobRemote });
  // Separate registries: bob's file knows nothing of alice.
  expect(bob.projects).toEqual([]);

  // The device's shared default config was never written.
  await expect(readdir(join(deviceHome, ".vsync"))).rejects.toMatchObject({ code: "ENOENT" });

  // ── Each user works their own clone; all commands resolve the override ──
  useConfigOf(aliceConfig);
  await runInitCommand(aliceClone, {
    projectId: "alice-app",
    backend: "local-fs",
    files: [".env"],
  });
  await runPushCommand(aliceClone, true, undefined, "silent");

  useConfigOf(bobConfig);
  await runInitCommand(bobClone, { projectId: "bob-app", backend: "local-fs", files: [".env"] });
  await runPushCommand(bobClone, true, undefined, "silent");

  // Pushes landed in each user's own storage, and only there.
  expect((await readdir(aliceRemote)).sort()).toEqual(["alice-app"]);
  expect((await readdir(bobRemote)).sort()).toEqual(["bob-app"]);

  // ── Registries stay isolated: list shows only the active user's projects ──
  useConfigOf(aliceConfig);
  vi.mocked(console.log).mockClear();
  await runListCommand(undefined, false);
  const aliceOut = vi
    .mocked(console.log)
    .mock.calls.map((a) => a.join(" "))
    .join("\n");
  expect(aliceOut).toContain("alice-app");
  expect(aliceOut).not.toContain("bob-app");

  vi.mocked(console.log).mockClear();
  useConfigOf(bobConfig);
  await runStatusCommand(bobClone, undefined, false); // exercises backendResolver too
  await runListCommand(undefined, false);
  const bobOut = vi
    .mocked(console.log)
    .mock.calls.map((a) => a.join(" "))
    .join("\n");
  expect(bobOut).toContain("bob-app");
  expect(bobOut).not.toContain("alice-app");

  // Alice's push stamped her registry in her file only.
  useConfigOf(aliceConfig);
  const aliceCfgNow = await readGlobalConfig();
  expect(aliceCfgNow.projects.find((p) => p.projectId === "alice-app")?.lastSyncedAt).toBeDefined();
  useConfigOf(bobConfig);
  expect(
    (await readGlobalConfig()).projects.find((p) => p.projectId === "alice-app"),
  ).toBeUndefined();
});

it("resolver error names the active config file when a profile is missing", async () => {
  // bobClone's manifest (from the session above) names local-fs; carol's
  // fresh config file has no profile for it.
  useConfigOf(join(deviceHome, "carol.json"));
  await expect(runStatusCommand(bobClone, undefined, false)).rejects.toThrow(
    new RegExp(`No saved profile for 'local-fs' in .+carol\\.json`),
  );
});

it("globalConfigPath reflects the override and falls back cleanly", () => {
  useConfigOf(aliceConfig);
  expect(globalConfigPath()).toBe(aliceConfig);
  delete process.env.VSYNC_CONFIG;
  // Falls back to VSYNC_HOME (the shared device default) — never real home.
  expect(globalConfigPath()).toBe(join(deviceHome, ".vsync", "config.json"));
  expect(globalConfigPath(deviceHome)).toBe(join(deviceHome, ".vsync", "config.json"));
});

const execFileAsync = promisify(execFile);

it("the real --config flag wires through to config I/O (spawned CLI, both flag positions)", async () => {
  const spawnCfg = join(deviceHome, "spawned.json");
  const remote = await mkdtemp(join(tmpdir(), "vsync-spawn-remote-"));
  // Child env: no ambient VSYNC_CONFIG (the flag must do all the work);
  // keep VSYNC_HOME as the safety net so a wiring bug can't touch real home.
  const env = { ...process.env, VSYNC_CONFIG: "" };
  try {
    // Flag BEFORE the subcommand: one-time per-user setup.
    const setup = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--config",
        spawnCfg,
        "config",
        "--backend",
        "local-fs",
        "--set",
        `basePath=${remote}`,
        "--json",
      ],
      { cwd: process.cwd(), env },
    );
    expect(JSON.parse(setup.stdout)).toEqual({
      backend: "local-fs",
      saved: true,
      secretsStored: [],
    });

    // Flag AFTER the subcommand: reads the same file the flag selected.
    const shown = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "config", "--show", "--json", "--config", spawnCfg],
      { cwd: process.cwd(), env },
    );
    expect(JSON.parse(shown.stdout).profiles["local-fs"]).toMatchObject({
      backend: "local-fs",
      settings: { basePath: remote },
    });

    // And the shared default config is still nowhere on the device.
    await expect(readdir(join(deviceHome, ".vsync"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(remote, { recursive: true, force: true });
  }
}, 120_000);
