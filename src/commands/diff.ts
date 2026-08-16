import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { resolveBackend } from "../core/backendResolver.js";
import { scanCandidates } from "../core/candidateScanner.js";
import { readManifest, type Manifest } from "../core/manifest.js";
import { computeFileSyncStates, STATUS_SECTIONS } from "../core/syncState.js";
import { remoteKeyFor } from "../utils/paths.js";

/**
 * `vsync diff` — tracked-file differences (paths only by default) plus an
 * untracked-candidates section reusing the init scanner. `--show-values`
 * opts into real content diffs: each differing tracked file is pulled to a
 * temp location and line-diffed against the local copy. Never on by
 * default — this is the one command that can print secret values.
 */

export async function runDiffCommand(
  projectRoot: string,
  showValues: boolean,
  homeDir?: string,
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
  const differCount = states.filter((s) => s.status !== "unchanged").length;
  console.log(
    `${manifest.files.length} tracked file(s), ` +
      (differCount > 0 ? `${differCount} differ` : "none differ"),
  );

  await showContentDiffs(projectRoot, manifest.projectId, differing, showValues, backend);
  await showUntrackedCandidates(projectRoot, manifest);
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
  const scratch = await mkdtemp(join(tmpdir(), "vsync-diff-"));
  try {
    for (const { entry, status, remoteFile } of differing) {
      console.log("");
      console.log(`── ${entry.path} (${status}) ──`);
      const localText = await readFile(join(projectRoot, entry.path), "utf8").catch(() => null);
      if (localText === null) {
        console.log("  (no local copy)");
        continue;
      }
      if (!remoteFile) {
        console.log("  (no remote copy — never pushed, or deleted on the backend)");
        continue;
      }
      const remoteCopy = join(scratch, entry.path.replace(/\//g, "_"));
      let remoteText: string | null = null;
      try {
        await backend.pull(remoteKeyFor(projectId, entry.path), remoteCopy);
        remoteText = await readFile(remoteCopy, "utf8");
      } catch (err) {
        console.log(
          `  (no remote copy — ${(err instanceof Error ? err.message : String(err)).trim()})`,
        );
      }
      if (remoteText === null) continue;

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
      for (const line of patch.split("\n").slice(1)) {
        if (line) console.log(line);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Untracked candidates: ignored files NOT in the manifest, classified by
 * the same scanner init uses. Suppressed items are never listed.
 */
async function showUntrackedCandidates(projectRoot: string, manifest: Manifest): Promise<void> {
  const manifestPaths = new Set(manifest.files.map((f) => f.path));
  const candidates = (await scanCandidates(projectRoot)).filter(
    (c) => c.classification !== "suppressed" && !manifestPaths.has(c.path),
  );
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
