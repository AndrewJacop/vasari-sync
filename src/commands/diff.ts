import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { resolveBackend } from "../core/backendResolver.js";
import { scanCandidates, type Candidate } from "../core/candidateScanner.js";
import { readManifest, type Manifest } from "../core/manifest.js";
import { computeFileSyncStates, STATUS_SECTIONS } from "../core/syncState.js";
import { remoteKeyFor } from "../utils/paths.js";
import { withSpinner } from "../utils/progress.js";

/**
 * `vsync diff` — tracked-file differences (paths only by default) plus an
 * untracked-candidates section reusing the init scanner. `--show-values`
 * opts into real content diffs: each differing tracked file is pulled to a
 * temp location and line-diffed against the local copy. Never on by
 * default — this is the one command that can print secret values.
 *
 * `--json` emits `{projectId, backend, files: [{path, status}], candidates,
 * patches?}` — `patches` (only with --show-values) carries the same
 * unified diffs the prose mode prints, one string per file.
 */
export async function runDiffCommand(
  projectRoot: string,
  showValues: boolean,
  homeDir?: string,
  json = false,
): Promise<void> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }
  const backend = await resolveBackend(projectRoot, homeDir);

  const remoteByKey = new Map(
    (await backend.list(`${manifest.projectId}/`)).map((f) => [f.path, f]),
  );
  const states = await computeFileSyncStates(projectRoot, manifest, remoteByKey);

  const differing = states.filter((s) => s.status !== "unchanged");
  const candidates = await untrackedCandidates(projectRoot, manifest);

  if (json) {
    const patches = showValues
      ? (await collectPatches(projectRoot, manifest.projectId, differing, backend))
          .filter((r) => r.patch !== undefined)
          .map((r) => ({ path: r.path, patch: r.patch as string }))
      : undefined;
    console.log(
      JSON.stringify(
        {
          projectId: manifest.projectId,
          backend: manifest.backend,
          files: differing.map(({ entry, status }) => ({ path: entry.path, status })),
          candidates: candidates.map((c) => ({
            path: c.path,
            size: c.size,
            classification: c.classification,
            ...(c.rule ? { rule: c.rule } : {}),
          })),
          ...(patches !== undefined ? { patches } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const section of STATUS_SECTIONS) {
    if (section.status === "unchanged") continue; // diff lists differences only
    const items = differing.filter((s) => s.status === section.status);
    if (items.length === 0) continue;
    console.log("");
    console.log(section.header);
    for (const { entry } of items) {
      console.log(`  ${entry.path}`);
    }
  }
  console.log(
    `${manifest.files.length} tracked file(s), ` +
      (differing.length > 0 ? `${differing.length} differ` : "none differ"),
  );

  await showContentDiffs(projectRoot, manifest.projectId, differing, showValues, backend);
  console.log("");
  if (candidates.length === 0) {
    console.log("Untracked candidates (same scan as `vsync init`): none");
    return;
  }
  console.log("Untracked candidates (same scan as `vsync init`):");
  for (const c of candidates) {
    const tag = c.classification === "boosted" ? ` — suggested (${c.rule})` : "";
    console.log(`  ${c.path} (${c.size} bytes)${tag}`);
  }
}

/**
 * With `--show-values`: git-style content diffs for every non-unchanged
 * tracked file. `-` lines are the last-synced base version, `+` lines the
 * side that changed since (for a conflict, where neither side holds the
 * base, `-` is the stored copy and `+` the local one). Files missing on
 * one side (never pushed, deleted locally) get a note under their header
 * instead of a diff, never a crash.
 */
async function showContentDiffs(
  projectRoot: string,
  projectId: string,
  differing: Awaited<ReturnType<typeof computeFileSyncStates>>,
  showValues: boolean,
  backend: Awaited<ReturnType<typeof resolveBackend>>,
): Promise<void> {
  if (!showValues || differing.length === 0) return;
  const results = await collectPatches(projectRoot, projectId, differing, backend);
  for (const r of results) {
    console.log("");
    console.log(`── ${r.path} (${r.status}) ──`);
    if (r.patch) console.log(r.patch);
    else console.log(`  ${r.note ?? "(no diff available)"}`);
  }
}

/** Per-file content-diff result: `patch` when both copies were readable,
 * otherwise a human-readable `note` (never a crash). */
interface PatchResult {
  path: string;
  status: string;
  patch?: string;
  note?: string;
}

/**
 * Builds one unified-diff string per differing file with both copies
 * available (shared by prose and `--json` modes). The diff's `-` side is
 * the last-synced base version, `+` the side that changed since (for a
 * conflict, where neither side holds the base, `-` is the stored copy
 * and `+` the local one). Files missing on one side (never pushed,
 * deleted locally, unreachable remote) get a note instead — same notes
 * the prose mode always printed.
 */
async function collectPatches(
  projectRoot: string,
  projectId: string,
  differing: Awaited<ReturnType<typeof computeFileSyncStates>>,
  backend: Awaited<ReturnType<typeof resolveBackend>>,
): Promise<PatchResult[]> {
  const scratch = await mkdtemp(join(tmpdir(), "vsync-diff-"));
  try {
    const results: PatchResult[] = [];
    for (const { entry, status, remoteFile } of differing) {
      const localText = await readFile(join(projectRoot, entry.path), "utf8").catch(() => null);
      if (localText === null) {
        results.push({ path: entry.path, status, note: "(no local copy)" });
        continue;
      }
      if (!remoteFile) {
        results.push({
          path: entry.path,
          status,
          note: "(no remote copy — never pushed, or deleted on the backend)",
        });
        continue;
      }
      const remoteCopy = join(scratch, entry.path.replace(/\//g, "_"));
      let remoteText: string | null = null;
      try {
        await withSpinner(`Fetching remote copy of ${entry.path}`, () =>
          backend.pull(remoteKeyFor(projectId, entry.path), remoteCopy),
        );
        remoteText = await readFile(remoteCopy, "utf8");
      } catch (err) {
        results.push({
          path: entry.path,
          status,
          note: `(no remote copy — ${(err instanceof Error ? err.message : String(err)).trim()})`,
        });
        continue;
      }
      // The unchanged side still holds the last-synced (base) content —
      // that side becomes the `-` half. A conflict has no base, so the
      // stored copy is treated as the base.
      const baseIsLocal = status === "remote-modified";
      const [oldText, newText, oldLabel, newLabel] = baseIsLocal
        ? ([localText, remoteText, "local", "remote"] as const)
        : ([remoteText, localText, "remote", "local"] as const);
      const patch = createTwoFilesPatch(
        `a/${entry.path}`,
        `b/${entry.path}`,
        oldText,
        newText,
        oldLabel,
        newLabel,
      );
      // Drop only the "=====" separator line — the ---/+++ header lines
      // carry the remote/local labels we want.
      results.push({ path: entry.path, status, patch: patch.split("\n").slice(1).join("\n") });
    }
    return results;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Untracked candidates: ignored files NOT in the manifest, classified by
 * the same scanner init uses. Suppressed items are never listed.
 */
async function untrackedCandidates(projectRoot: string, manifest: Manifest): Promise<Candidate[]> {
  const manifestPaths = new Set(manifest.files.map((f) => f.path));
  return (await scanCandidates(projectRoot)).filter(
    (c) => c.classification !== "suppressed" && !manifestPaths.has(c.path),
  );
}
