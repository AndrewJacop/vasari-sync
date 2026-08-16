import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
  type ProjectConfig,
} from "../../../src/core/projectConfig.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vsync-projcfg-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    projectId: "demo-project",
    backend: "s3",
    settings: { bucket: "my-bucket", region: "us-east-1", remoteBasePath: "demo" },
    ...overrides,
  };
}

describe("readProjectConfig / writeProjectConfig", () => {
  it("returns null for an uninitialized project (no throw)", async () => {
    await expect(readProjectConfig(root)).resolves.toBeNull();
  });

  it("creates .vsync/config.json on write and round-trips", async () => {
    await writeProjectConfig(root, config());

    const target = projectConfigPath(root);
    const raw = await readFile(target, "utf8");
    expect(raw).toContain('"backend": "s3"');
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw) as ProjectConfig;
    expect(Object.keys(parsed)).toEqual(["projectId", "backend", "settings"]); // settings nested, not flattened
    await expect(readProjectConfig(root)).resolves.toEqual(config());
  });

  it("fails loudly on a corrupt config", async () => {
    await writeFile(projectConfigPath(root), "{ not json", "utf8");
    await expect(readProjectConfig(root)).rejects.toThrow(/Corrupt project config/);
  });

  it("propagates non-ENOENT read errors (config path occupied by a directory)", async () => {
    const target = projectConfigPath(root);
    await rm(target, { force: true }); // a prior test may have left a file here
    await mkdir(target, { recursive: true });
    await expect(readProjectConfig(root)).rejects.toThrow();
    await rm(target, { recursive: true, force: true });
  });
});

describe("secret guard — project config must never hold secrets", () => {
  it("refuses a top-level secret-looking key", async () => {
    await expect(
      writeProjectConfig(root, config({ settings: { bucket: "b", password: "nope" } })),
    ).rejects.toThrow(/'password'/);
  });

  it("refuses secret-looking keys nested inside setting objects", async () => {
    await expect(
      writeProjectConfig(root, config({ settings: { auth: { token: "nope" }, bucket: "b" } })),
    ).rejects.toThrow(/'token'/);
  });

  it("refuses privateKey even when only part of the name", async () => {
    await expect(
      writeProjectConfig(root, config({ settings: { privateKeyPath: "/id_rsa" } })),
    ).rejects.toThrow(/'privateKeyPath'/);
  });

  it("accepts ordinary non-secret settings", async () => {
    await writeProjectConfig(
      root,
      config({ settings: { bucket: "b", host: "example.com", username: "deploy", port: 22 } }),
    );
    const back = await readProjectConfig(root);
    expect(back?.settings).toEqual({
      bucket: "b",
      host: "example.com",
      username: "deploy",
      port: 22,
    });
  });
});
