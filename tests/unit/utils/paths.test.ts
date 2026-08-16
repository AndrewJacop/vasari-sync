import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFsHandler } from "../../../src/storage/handlers/local-fs.js";
import {
  remoteKeyFor,
  toProjectRelativePath,
  validateProjectId,
} from "../../../src/utils/paths.js";

/**
 * Cross-platform path-contract tests (plan Task 18). Everything here runs
 * on every platform; separator-sensitive behavior that genuinely differs
 * is exercised natively by running this file on Windows (sep = "\") and
 * POSIX (sep = "/") — the contract under test is that results are
 * IDENTICAL regardless.
 */

let root: string;
let remoteDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vsync-paths-"));
  remoteDir = await mkdtemp(join(tmpdir(), "vsync-paths-remote-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(remoteDir, { recursive: true, force: true });
});

describe("remoteKeyFor", () => {
  it("joins with a forward slash, whatever the host separator", () => {
    expect(remoteKeyFor("proj", ".env")).toBe("proj/.env");
    expect(remoteKeyFor("proj", "config/app.env")).toBe("proj/config/app.env");
  });

  it("never emits the host separator", () => {
    // On POSIX the host separator IS "/", so this is trivial there — the
    // assertion only bites on Windows.
    expect(remoteKeyFor("proj", "config/app.env")).not.toContain("\\");
  });
});

describe("toProjectRelativePath", () => {
  it("accepts forward-slash relative input on every platform", () => {
    expect(toProjectRelativePath(root, "config/app.env")).toBe("config/app.env");
  });

  it("accepts native-separator relative input (backslash on Windows)", () => {
    // join() yields "config\\app.env" on win32, "config/app.env" on POSIX —
    // the returned manifest path must be posix-style in both cases.
    expect(toProjectRelativePath(root, join("config", "app.env"))).toBe("config/app.env");
  });

  it("accepts absolute input using native separators", () => {
    expect(toProjectRelativePath(root, join(root, "config", "app.env"))).toBe("config/app.env");
  });

  it("rejects the project root itself", () => {
    expect(() => toProjectRelativePath(root, ".")).toThrow(/outside the project root/);
    expect(() => toProjectRelativePath(root, join("config", ".."))).toThrow(
      /outside the project root/,
    );
  });

  it("rejects paths outside the root, relative or absolute", () => {
    expect(() => toProjectRelativePath(root, "../outside.txt")).toThrow(/outside the project root/);
    expect(() => toProjectRelativePath(root, resolve(root, "..", "outside.txt"))).toThrow(
      /outside the project root/,
    );
  });

  it("allows filenames that merely start with '..'", () => {
    // Guards the classic overreach of testing startsWith("..") instead of
    // the exact escape patterns — "..weird.env" is inside the root.
    expect(toProjectRelativePath(root, "..weird.env")).toBe("..weird.env");
  });

  describe("on Windows", () => {
    it.skipIf(process.platform !== "win32")(
      "accepts absolute input written entirely with forward slashes",
      () => {
        const abs = [root, "config", "app.env"].join("/"); // C:\...\root/config/app.env
        expect(toProjectRelativePath(root, abs)).toBe("config/app.env");
      },
    );
  });
});

describe("validateProjectId", () => {
  it("accepts normal IDs", () => {
    expect(validateProjectId("my-project")).toBe(true);
    expect(validateProjectId("  my_project_2  ")).toBe(true);
  });

  it("rejects empty and whitespace-only IDs", () => {
    expect(validateProjectId("")).toMatch(/required/);
    expect(validateProjectId("   ")).toMatch(/required/);
  });

  it("rejects path separators in either style", () => {
    expect(validateProjectId("my/proj")).toMatch(/must not contain/);
    expect(validateProjectId("my\\proj")).toMatch(/must not contain/);
  });

  it("rejects '.' and '..' (join() would collapse them)", () => {
    expect(validateProjectId(".")).toMatch(/collapse/);
    expect(validateProjectId("..")).toMatch(/collapse/);
  });
});

describe("local-fs backend under a nested posix key (executable posix-key proof)", () => {
  it("push/list/pull keep remote keys posix-style while using native paths on disk", async () => {
    const localAbs = join(root, "config", "app.env");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(localAbs, "SECRET=posix-keys\n", "utf8");

    const backend = new LocalFsHandler({ basePath: remoteDir });
    await backend.push(localAbs, remoteKeyFor("proj", "config/app.env"));

    // On-disk layout is native (backslash-separated on Windows) — proof the
    // key was split on "/" rather than passed through as one filename.
    expect(existsSync(join(remoteDir, "proj", "config", "app.env"))).toBe(true);

    const files = await backend.list("proj/");
    expect(files.map((f) => f.path)).toEqual(["proj/config/app.env"]);
    expect(files[0].path).not.toContain("\\");

    const restored = join(root, "restored", "app.env");
    await backend.pull("proj/config/app.env", restored);
    expect(await readFile(restored, "utf8")).toBe("SECRET=posix-keys\n");
  });
});
