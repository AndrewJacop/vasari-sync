import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveBackend } from "../core/backendResolver.js";
import { readGlobalConfig, upsertProjectEntry, writeGlobalConfig } from "../core/globalConfig.js";
import { hashFile } from "../core/hash.js";
import { readManifest, writeManifest } from "../core/manifest.js";
import { computeFileSyncStates, type FileSyncState } from "../core/syncState.js";
import { remoteKeyFor } from "../utils/paths.js";

/**
 * `vsync pull` — download tracked files that changed on the backend since
 * the last sync. Mirror of `push`, opposite direction.
 *
 * Per-file semantics (never all-or-nothing):
 * - unchanged → skipped;
 * - remote-modified → downloaded;
 * - missing-locally with a remote copy → downloaded (restore: fresh clone
 *   or locally deleted file);
 * - conflict (both sides changed) → REFUSED without `--force`;
 * - local-modified (local changed, remote didn't) → REFUSED without
 *   `--force` too — pulling would overwrite local changes with a remote
 *   copy identical to `lastSyncedHash`, pure data loss for zero gain
 *   (push is the right move there);
 * - remote-missing (deleted on the backend, or never pushed) → reported
 *   clearly, never a crash — the user must decide: push to restore the
 *   remote copy or `vsync rm` to stop tracking.
 *
 * `lastSyncedHash`/`lastSyncedAt` are stamped ONLY after that specific
 * file's download confirmed success (re-hashing the file just written —
 * the pulled content is the new synced truth, and re-hashing stays
 * correct even where the backend's etagOrHash uses another scheme).
 * Partial failures leave the manifest accurate per-file, not
 * all-or-nothing.
 */

export type PullOutcome =
  "pulled" | "skipped-unchanged" | "conflicted" | "needs-push" | "missing-remotely" | "failed";

/** Per-file line: actionable, states exactly why a file wasn't pulled. */
const OUTCOME_LABEL: Record<PullOutcome, string> = {
  pulled: "pulled",
  "skipped-unchanged": "skipped (unchanged)",
  conflicted:
    "REFUSED (conflict: changed locally AND remotely — re-run with --force to overwrite your local copy)",
  "needs-push":
    "REFUSED (changed locally only — run `vsync push` first, or --force to overwrite your local copy)",
  "missing-remotely": "skipped (no remote copy)",
  failed: "FAILED",
};

/** Totals line: compact versions of the same outcomes. */
const OUTCOME_SUMMARY: Record<PullOutcome, string> = {
  pulled: "pulled",
  "skipped-unchanged": "skipped (unchanged)",
  conflicted: "refused (conflict)",
  "needs-push": "refused (local changed)",
  "missing-remotely": "skipped (no remote copy)",
  failed: "failed",
};

interface PullResult {
  path: string;
  outcome: PullOutcome;
  note?: string;
}

export async function runPullCommand(
  projectRoot: string,
  force: boolean,
  homeDir?: string,
): Promise<void> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }
  const backend = await resolveBackend(projectRoot, homeDir);

  // One listing covers every tracked file; the projectId prefix scopes it.
  const remoteByKey = new Map(
    (await backend.list(`${manifest.projectId}/`)).map((f) => [f.path, f]),
  );
  const states = await computeFileSyncStates(projectRoot, manifest, remoteByKey);

  console.log(
    `Project '${manifest.projectId}' (backend: ${manifest.backend}) — ${manifest.files.length} tracked file(s)`,
  );
  if (manifest.files.length === 0) {
    console.log("No tracked files yet — use `vsync add <path>` or re-run `vsync init`.");
    return;
  }

  // Loud, up-front warning about what --force destroys — before any download.
  const forceTargets = states.filter(
    (s) => s.status === "conflict" || s.status === "local-modified",
  );
  if (force && forceTargets.length > 0) {
    console.warn(
      `WARNING: --force overwrites your LOCAL file(s) with the remote version — ` +
        `local-only changes to ${forceTargets.length} file(s) will be LOST: ` +
        forceTargets.map((s) => s.entry.path).join(", "),
    );
  }

  const results: PullResult[] = [];
  const syncedAt = new Date().toISOString();
  let dirty = false;

  const attemptPull = async (state: FileSyncState, note?: string): Promise<void> => {
    const { entry } = state;
    const abs = join(projectRoot, entry.path);
    try {
      await backend.pull(remoteKeyFor(manifest.projectId, entry.path), abs);
      const content = await hashFile(abs);
      const info = await stat(abs);
      entry.hash = content;
      entry.lastSyncedHash = content;
      entry.lastSyncedAt = syncedAt;
      entry.size = info.size;
      entry.mtimeLocal = info.mtime.toISOString();
      dirty = true;
      results.push({ path: entry.path, outcome: "pulled", note });
    } catch (err) {
      results.push({
        path: entry.path,
        outcome: "failed",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  };

  for (const state of states) {
    const { entry } = state;
    if (state.status === "unchanged") {
      results.push({ path: entry.path, outcome: "skipped-unchanged" });
      continue;
    }
    if (state.status === "remote-missing") {
      results.push({
        path: entry.path,
        outcome: "missing-remotely",
        note:
          entry.lastSyncedHash === undefined
            ? "never pushed"
            : "deleted on the backend — push to restore, or `vsync rm` to untrack",
      });
      continue;
    }
    if (state.status === "missing-locally") {
      // No local file: a remote copy makes this a restore; without one
      // there is nothing to pull from either side.
      if (remoteByKey.has(remoteKeyFor(manifest.projectId, entry.path))) {
        await attemptPull(state, "restored");
      } else {
        results.push({
          path: entry.path,
          outcome: "missing-remotely",
          note: "no local copy either",
        });
      }
      continue;
    }
    const overwritesLocal = state.status === "conflict" || state.status === "local-modified";
    if (overwritesLocal && !force) {
      results.push({
        path: entry.path,
        outcome: state.status === "conflict" ? "conflicted" : "needs-push",
      });
      continue;
    }
    await attemptPull(state);
  }

  if (dirty) {
    await writeManifest(projectRoot, manifest);
  }

  for (const r of results) {
    console.log(`  ${r.path} — ${OUTCOME_LABEL[r.outcome]}${r.note ? ` (${r.note})` : ""}`);
  }
  const counts = new Map<PullOutcome, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  // Fixed order so the summary doesn't shuffle with file sort order.
  const SUMMARY_ORDER: PullOutcome[] = [
    "pulled",
    "skipped-unchanged",
    "conflicted",
    "needs-push",
    "missing-remotely",
    "failed",
  ];
  const summary: string[] = [];
  for (const outcome of SUMMARY_ORDER) {
    const n = counts.get(outcome);
    if (n) summary.push(`${n} ${OUTCOME_SUMMARY[outcome]}`);
  }
  console.log(`Summary: ${summary.join(", ")}`);

  // Stamp the global registry's lastSyncedAt (what `vsync list` shows) —
  // only when something actually downloaded.
  if (counts.get("pulled")) {
    const global = await readGlobalConfig(homeDir);
    upsertProjectEntry(global, {
      projectId: manifest.projectId,
      path: projectRoot,
      backend: manifest.backend,
      lastSyncedAt: syncedAt,
    });
    await writeGlobalConfig(global, homeDir);
  }

  const conflicts = counts.get("conflicted") ?? 0;
  const needsPush = counts.get("needs-push") ?? 0;
  const failed = counts.get("failed") ?? 0;
  if (conflicts + needsPush + failed > 0) {
    const reasons: string[] = [];
    if (conflicts > 0) reasons.push(`${conflicts} conflicted (needs --force)`);
    if (needsPush > 0) reasons.push(`${needsPush} changed locally (push first, or --force)`);
    if (failed > 0) reasons.push(`${failed} failed to download`);
    throw new Error(
      `Pull incomplete — ${reasons.join("; ")}. ` +
        `The manifest records only successful downloads.`,
    );
  }
}
