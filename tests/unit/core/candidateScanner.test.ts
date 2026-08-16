import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOOST_MAX_BYTES,
  scanCandidates,
  SUPPRESS_DIR_NAMES,
  SUPPRESS_MAX_BYTES,
  type Candidate,
} from "../../../src/core/candidateScanner.js";

const execFileAsync = promisify(execFile);

/**
 * Every fixture is a REAL git repo (git init + .gitignore + dummy files),
 * per the plan — nested-gitignore and negation semantics must be genuinely
 * exercised, not hand-mocked porcelain output.
 */

let workRoot: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "vsync-scanner-"));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

/** Creates a fresh temp repo and returns its root. */
async function makeRepo(name: string): Promise<string> {
  const root = join(workRoot, name);
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  return root;
}

function byPath(candidates: Candidate[], path: string): Candidate | undefined {
  return candidates.find((c) => c.path === path);
}

describe("scanCandidates — main fixture (plan's validation trees)", () => {
  let root: string;
  let result: Candidate[];

  beforeAll(async () => {
    root = await makeRepo("main");
    await writeFile(
      join(root, ".gitignore"),
      ".env*\nlocal-notes.txt\nbig.bin\nnode_modules/\ndist/\n",
    );
    // Boosted: .env (pattern, tiny).
    await writeFile(join(root, ".env"), "A=1");
    // Shown-unchecked: generic ignored file.
    await writeFile(join(root, "local-notes.txt"), "notes");
    // Suppressed by size: 11MB ignored binary.
    await writeFile(join(root, "big.bin"), Buffer.alloc(SUPPRESS_MAX_BYTES + 1, 1));
    // Suppressed by dir: node_modules + dist trees.
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(root, "node_modules", "left-pad", "package.json"), "{}");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.js"), "x");
    // Untracked but NOT ignored — must never appear.
    await writeFile(join(root, "notes.md"), "tracked someday");
    // Tracked file — must never appear.
    await writeFile(join(root, "README.md"), "# x");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: root },
    );
    // Tracked-and-modified file — also not a candidate.
    await writeFile(join(root, "README.md"), "# changed");

    result = await scanCandidates(root);
  });

  it("classifies .env as boosted with the matching rule", () => {
    expect(byPath(result, ".env")).toEqual({
      path: ".env",
      size: 3,
      classification: "boosted",
      rule: "pattern:.env*",
    });
  });

  it("classifies a generic ignored file as shown, unchecked, no rule", () => {
    expect(byPath(result, "local-notes.txt")).toEqual({
      path: "local-notes.txt",
      size: 5,
      classification: "shown",
      rule: "",
    });
  });

  it("suppresses an over-size ignored binary by size", () => {
    expect(byPath(result, "big.bin")).toMatchObject({
      classification: "suppressed",
      rule: "size:>10MB",
    });
  });

  it("suppresses every file inside node_modules/ and dist/ entirely", () => {
    expect(byPath(result, "node_modules/left-pad/package.json")).toMatchObject({
      classification: "suppressed",
      rule: "dir:node_modules",
    });
    expect(byPath(result, "dist/bundle.js")).toMatchObject({
      classification: "suppressed",
      rule: "dir:dist",
    });
  });

  it("never surfaces untracked-non-ignored, tracked, or tracked-modified files", () => {
    expect(byPath(result, "notes.md")).toBeUndefined();
    expect(byPath(result, "README.md")).toBeUndefined();
  });

  it("orders output boosted → shown → suppressed, alphabetical within groups", () => {
    expect(result.map((c) => c.classification)).toEqual([
      ...Array(result.filter((c) => c.classification === "boosted").length).fill("boosted"),
      ...Array(result.filter((c) => c.classification === "shown").length).fill("shown"),
      ...Array(result.filter((c) => c.classification === "suppressed").length).fill("suppressed"),
    ]);
    const boosted = result.filter((c) => c.classification === "boosted").map((c) => c.path);
    expect([...boosted].sort()).toEqual(boosted);
  });
});

describe("scanCandidates — nested .gitignore and negation semantics", () => {
  let root: string;
  let result: Candidate[];

  beforeAll(async () => {
    root = await makeRepo("nested");
    await writeFile(join(root, ".gitignore"), "out/\n*.log\n");
    // Nested gitignore: ignore *.local but negate keep.local.
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", ".gitignore"), "*.local\n!keep.local\n");
    await writeFile(join(root, "sub", "a.local"), "a");
    await writeFile(join(root, "sub", "keep.local"), "k");
    await writeFile(join(root, "sub", "debug.log"), "l");
    // Ignored dir: plain file shows, but a suppress-named dir inside it is
    // suppressed at any depth.
    await mkdir(join(root, "out", "dist"), { recursive: true });
    await writeFile(join(root, "out", "plain.txt"), "p");
    await writeFile(join(root, "out", "dist", "f.txt"), "f");

    result = await scanCandidates(root);
  });

  it("honors the nested .gitignore: a.local is ignored", () => {
    expect(byPath(result, "sub/a.local")).toBeDefined();
  });

  it("honors the negation: keep.local is NOT a candidate", () => {
    expect(byPath(result, "sub/keep.local")).toBeUndefined();
  });

  it("classifies an ignored log file as shown-unchecked (not boosted)", () => {
    expect(byPath(result, "sub/debug.log")).toEqual({
      path: "sub/debug.log",
      size: 1,
      classification: "shown",
      rule: "",
    });
  });

  it("shows a plain file under an ignored dir, but suppresses a suppress-named dir at any depth", () => {
    expect(byPath(result, "out/plain.txt")).toMatchObject({
      classification: "shown",
      rule: "",
    });
    expect(byPath(result, "out/dist/f.txt")).toMatchObject({
      classification: "suppressed",
      rule: "dir:dist",
    });
  });

  it("does not surface the nested .gitignore itself (untracked, not ignored)", () => {
    expect(byPath(result, "sub/.gitignore")).toBeUndefined();
  });
});

describe("scanCandidates — boost pattern variants and size cutoff", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeRepo("patterns");
    await writeFile(
      join(root, ".gitignore"),
      ".env\n.env.local\nclient-secret.json\naws-credentials.txt\nserver.pem\nsigning.key\nid_rsa\nid_rsa.pub\nconfig.local.yaml\nhuge.pem\n.env-max\nbig.txt\n",
    );
    await writeFile(join(root, ".env"), "a");
    await writeFile(join(root, ".env.local"), "a");
    await writeFile(join(root, "client-secret.json"), "a");
    await writeFile(join(root, "aws-credentials.txt"), "a");
    await writeFile(join(root, "server.pem"), "a");
    await writeFile(join(root, "signing.key"), "a");
    await writeFile(join(root, "id_rsa"), "a");
    await writeFile(join(root, "id_rsa.pub"), "a");
    await writeFile(join(root, "config.local.yaml"), "a");
    // Boost-pattern name but over the boost cutoff → still shown, not boosted.
    await writeFile(join(root, "huge.pem"), Buffer.alloc(BOOST_MAX_BYTES + 1, 1));
    // Boost-pattern name exactly at the cutoff → boosted (boundary inclusive).
    await writeFile(join(root, ".env-max"), Buffer.alloc(BOOST_MAX_BYTES, 1));
    // Plain name over boost cutoff but under suppress cutoff → shown.
    await writeFile(join(root, "big.txt"), Buffer.alloc(BOOST_MAX_BYTES + 1, 1));
  });

  it("boosts every AGENTS.md filename pattern with its named rule", async () => {
    const result = await scanCandidates(root);
    const expectations: Array<[string, string]> = [
      [".env", "pattern:.env*"],
      [".env.local", "pattern:.env*"],
      ["client-secret.json", "pattern:*secret*"],
      ["aws-credentials.txt", "pattern:*credential*"],
      ["server.pem", "pattern:*.pem"],
      ["signing.key", "pattern:*.key"],
      ["id_rsa", "pattern:id_rsa*"],
      ["id_rsa.pub", "pattern:id_rsa*"],
      ["config.local.yaml", "pattern:config.local.*"],
    ];
    for (const [path, rule] of expectations) {
      expect(byPath(result, path), path).toMatchObject({ classification: "boosted", rule });
    }
  });

  it("demotes an oversized boost-pattern file to shown, and keeps the boundary inclusive", async () => {
    const result = await scanCandidates(root);
    expect(byPath(result, "huge.pem")).toMatchObject({ classification: "shown", rule: "" });
    expect(byPath(result, ".env-max")).toMatchObject({ classification: "boosted" });
    expect(byPath(result, "big.txt")).toMatchObject({ classification: "shown", rule: "" });
  });
});

describe("scanCandidates — edge cases", () => {
  it("returns [] for a repo with nothing ignored", async () => {
    const root = await makeRepo("empty");
    await writeFile(join(root, "readme.txt"), "x");
    expect(await scanCandidates(root)).toEqual([]);
  });

  it("handles ignored paths containing spaces and parentheses", async () => {
    const root = await makeRepo("spaces");
    await writeFile(join(root, ".gitignore"), "weird name (v1).txt\n");
    await writeFile(join(root, "weird name (v1).txt"), "x");
    const result = await scanCandidates(root);
    expect(byPath(result, "weird name (v1).txt")).toMatchObject({ classification: "shown" });
  });

  it("throws a clear error outside a git repository", async () => {
    const notRepo = await mkdtemp(join(tmpdir(), "vsync-nogit-"));
    try {
      await expect(scanCandidates(notRepo)).rejects.toThrow(/git status failed/);
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });
});

describe("suppress dir coverage", () => {
  it("suppresses a file under every SUPPRESS_DIR_NAMES entry", async () => {
    const root = await makeRepo("dirs");
    const ignoreLines = SUPPRESS_DIR_NAMES.map((d) => `${d}/`);
    await writeFile(join(root, ".gitignore"), ignoreLines.join("\n") + "\n");
    for (const dir of SUPPRESS_DIR_NAMES) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "f.txt"), "x");
    }
    const result = await scanCandidates(root);
    for (const dir of SUPPRESS_DIR_NAMES) {
      expect(byPath(result, `${dir}/f.txt`), dir).toMatchObject({
        classification: "suppressed",
        rule: `dir:${dir}`,
      });
    }
    expect(result.every((c) => c.classification === "suppressed")).toBe(true);
  });
});
