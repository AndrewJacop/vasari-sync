import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Candidate scanning for `vsync init` / `diff`: find files git ignores and
 * classify them as likely-sync-worthy (boosted → pre-checked in the
 * selection prompt), shown-unchecked (default), or suppressed (excluded
 * from the list entirely).
 *
 * Gitignore semantics (project-level, nested, global excludesfile,
 * negations) are delegated to git itself via `git status --ignored` — never
 * hand-rolled glob matching.
 */

export type CandidateClassification = "boosted" | "shown" | "suppressed";

export interface Candidate {
  /** Repo-relative path, posix-style (forward slashes, even on Windows). */
  path: string;
  size: number;
  classification: CandidateClassification;
  /**
   * Rule that fired, e.g. `pattern:.env*`, `dir:node_modules`,
   * `size:>10MB`. Empty string for plain shown-unchecked files.
   */
  rule: string;
  /**
   * Set only for candidates found inside a nested git repo (a directory
   * the outer repo ignores that carries its own `.git`): the repo-root-
   * relative path of that nested repo, e.g. `optolink-backend`. Lets the
   * init tree prompt tag repo folders without touching the filesystem.
   */
  nestedRepo?: string;
}

/** Basename patterns marking a file as likely sync-worthy. Case-insensitive. */
export const BOOST_FILENAME_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: ".env*", re: /^\.env/i },
  { name: "*secret*", re: /secret/i },
  { name: "*credential*", re: /credential/i },
  { name: "*.pem", re: /\.pem$/i },
  { name: "*.key", re: /\.key$/i },
  { name: "id_rsa*", re: /^id_rsa/i },
  { name: "config.local.*", re: /^config\.local\./i },
];

/**
 * Directory names whose contents are suppressed entirely (build outputs,
 * dependency trees, caches/logs — regenerable bulk, not config). Matched
 * against path segments, so `packages/app/dist/x.js` is suppressed too.
 */
export const SUPPRESS_DIR_NAMES: readonly string[] = [
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  "__pycache__",
  // vsync's own metadata dir: if a user ignores `.vsync/` (project or
  // global gitignore), its manifest/config must never become sync
  // candidates — that's the tool syncing its own state book.
  ".vsync",
  // Common cache/log directories (AGENTS.md leaves the set open — extend freely).
  ".cache",
  ".gradle",
  ".mypy_cache",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".terraform",
  ".turbo",
  ".venv",
  "coverage",
  "logs",
];

/** A boosted file must be plausibly a config/secrets file, not a dump. */
export const BOOST_MAX_BYTES = 50 * 1024; // ~50KB, per AGENTS.md

/** Anything bigger is treated as a build artifact, not config. */
export const SUPPRESS_MAX_BYTES = 10 * 1024 * 1024; // 10MB

const SUPPRESS_DIR_SET = new Set(SUPPRESS_DIR_NAMES);

const CLASS_RANK: Record<CandidateClassification, number> = {
  boosted: 0,
  shown: 1,
  suppressed: 2,
};

/**
 * Scans the git repository at `projectRoot` for ignored files and
 * classifies each. Result order: boosted first, then shown, then
 * suppressed (alphabetical by path within each group) — ready for the
 * init prompt as-is.
 *
 * Directories the outer repo ignores that carry their own `.git` (nested
 * repos, handled from inside themselves) are scanned recursively as part
 * of the umbrella project: the nested repo's own .gitignore decides what
 * is a candidate, and paths are prefixed so the manifest stays
 * project-root-relative.
 *
 * Suppressed-by-directory entries carry `size: 0` on purpose: we never
 * stat them, so a 30k-file node_modules costs only porcelain output, not
 * 30k syscalls.
 *
 * Throws (with git's own message folded in) when the directory isn't a
 * git repository — vsync's candidate model is gitignore-based, so there
 * is nothing meaningful to scan without git.
 */
/**
 * Code-unit path ordering (deterministic across machines/locales).
 */
function cmpPaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A collapsed `!! dir/` porcelain entry means git refused to descend —
 * which (with --untracked-files=all) happens exactly when the directory
 * carries its own `.git`. The cap keeps a pathological self-symlinked
 * repo from looping.
 */
const MAX_NESTED_REPO_DEPTH = 8;

export async function scanCandidates(projectRoot: string): Promise<Candidate[]> {
  const candidates = await scanRepo(projectRoot, "", undefined, 0);
  candidates.sort(
    (a, b) => CLASS_RANK[a.classification] - CLASS_RANK[b.classification] || cmpPaths(a.path, b.path),
  );
  return candidates;
}

/**
 * One `git status --ignored` pass over a single repo. `prefix` makes
 * nested-repo paths project-root-relative; `repoRoot` (undefined at the
 * top level) tags candidates with the nested repo they came from.
 */
async function scanRepo(
  repoRootPath: string,
  prefix: string,
  repoRoot: string | undefined,
  depth: number,
): Promise<Candidate[]> {
  // -z: NUL-separated, unquoted paths (spaces/parens safe).
  // --untracked-files=all: expands ignored directories into individual
  // files, so per-file size/pattern rules actually see every file.
  let stdout: string;
  try {
    const res = await execFileAsync(
      "git",
      ["status", "--porcelain", "--ignored", "--untracked-files=all", "-z"],
      // A fully expanded node_modules can produce megabytes of porcelain.
      { cwd: repoRootPath, maxBuffer: 128 * 1024 * 1024 },
    );
    stdout = res.stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `Cannot scan candidates in '${repoRootPath}': git status failed — ` +
        `is this a git repository, and is git installed? (${(e.stderr ?? e.message ?? "").trim()})`,
    );
  }

  const candidates: Candidate[] = [];
  for (const entry of stdout.split("\0")) {
    if (!entry.startsWith("!! ")) continue; // only ignored files are candidates
    const path = entry.slice(3);
    if (!path) continue;

    // A trailing slash is git's "I refused to descend" marker: with
    // --untracked-files=all that only happens for directories carrying
    // their own .git (nested repo) or a dir git offers nothing for. Scan
    // into the former; never surface the collapsed entry as a fake file.
    if (path.endsWith("/")) {
      const dir = path.slice(0, -1);
      if ((await exists(join(repoRootPath, dir, ".git"))) && depth < MAX_NESTED_REPO_DEPTH) {
        const nestedPrefix = prefix + dir + "/";
        candidates.push(
          ...(await scanRepo(join(repoRootPath, dir), nestedPrefix, prefix + dir, depth + 1)),
        );
      }
      continue;
    }

    const segments = path.split("/");
    const basename = segments.at(-1) ?? "";
    const dirSegments = segments.slice(0, -1);

    // Directory suppression first: no stat needed, cheap and total.
    const suppressedDir = dirSegments.find((s) => SUPPRESS_DIR_SET.has(s));
    if (suppressedDir) {
      candidates.push({
        path: prefix + path,
        size: 0,
        classification: "suppressed",
        rule: `dir:${suppressedDir}`,
        ...(repoRoot ? { nestedRepo: repoRoot } : {}),
      });
      continue;
    }

    let size: number;
    try {
      const info = await stat(join(repoRootPath, path));
      size = info.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // vanished mid-scan — skip
      throw err;
    }

    if (size > SUPPRESS_MAX_BYTES) {
      candidates.push({
        path: prefix + path,
        size,
        classification: "suppressed",
        rule: `size:>${Math.round(SUPPRESS_MAX_BYTES / 1024 / 1024)}MB`,
        ...(repoRoot ? { nestedRepo: repoRoot } : {}),
      });
      continue;
    }

    const boostHit = BOOST_FILENAME_PATTERNS.find(({ re }) => re.test(basename));
    if (boostHit && size <= BOOST_MAX_BYTES) {
      candidates.push({
        path: prefix + path,
        size,
        classification: "boosted",
        rule: `pattern:${boostHit.name}`,
        ...(repoRoot ? { nestedRepo: repoRoot } : {}),
      });
    } else {
      // Includes boost-pattern names that are too big to trust as config.
      candidates.push({
        path: prefix + path,
        size,
        classification: "shown",
        rule: "",
        ...(repoRoot ? { nestedRepo: repoRoot } : {}),
      });
    }
  }

  return candidates;
}
