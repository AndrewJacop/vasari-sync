import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveBackend } from "../core/backendResolver.js";
import { readGlobalConfig, upsertProjectEntry, writeGlobalConfig } from "../core/globalConfig.js";
import { readManifest, writeManifest } from "../core/manifest.js";
import { computeFileSyncStates, type FileSyncState } from "../core/syncState.js";
import { Spinner } from "../utils/progress.js";
import { remoteKeyFor } from "../utils/paths.js";

/**
 * `vsync push` — upload tracked files that changed since the last sync.
 *
 * Per-file semantics (never all-or-nothing):
 * - unchanged → skipped;
 * - local-modified / never-pushed (remote-missing) → uploaded;
 * - conflict (both sides changed) → REFUSED without `--force`;
 * - remote-modified (remote changed, local didn't) → REFUSED without
 *   `--force` too — pushing would silently destroy the other machine's
 *   changes for zero gain (pull is the right move there);
 * - missing-locally → reported, not uploaded (push can't delete; see the
 *   pull task for remote-side handling).
 *
 * `lastSyncedHash`/`lastSyncedAt` are stamped ONLY after that specific
 * file's upload confirmed success, so a partial failure leaves the
 * manifest accurate for every file that did upload. The manifest is
 * mutated in place (the state entries reference it) and written once at
 * the end, only if anything changed.
 */

type PushOutcome =
  "pushed" | "skipped-unchanged" | "conflicted" | "needs-pull" | "missing-locally" | "failed";

/** Per-file line: actionable, states exactly why a file wasn't pushed. */
const OUTCOME_LABEL: Record<PushOutcome, string> = {
  pushed: "pushed",
  "skipped-unchanged": "skipped (unchanged)",
  conflicted:
    "REFUSED (conflict: changed locally AND remotely — re-run with --force to overwrite the remote copy)",
  "needs-pull": "REFUSED (changed remotely only — run `vsync pull` first, or --force to overwrite)",
  "missing-locally": "skipped (no local file)",
  failed: "FAILED",
};

/** Totals line: compact versions of the same outcomes. */
const OUTCOME_SUMMARY: Record<PushOutcome, string> = {
  pushed: "pushed",
  "skipped-unchanged": "skipped (unchanged)",
  conflicted: "refused (conflict)",
  "needs-pull": "refused (remote changed)",
  "missing-locally": "skipped (no local file)",
  failed: "failed",
};

interface PushResult {
  path: string;
  outcome: PushOutcome;
  note?: string;
}

export async function runPushCommand(
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

  // Loud, up-front warning about what --force destroys — before any upload.
  const forceTargets = states.filter(
    (s): s is FileSyncState & { currentHash: string } =>
      (s.status === "conflict" || s.status === "remote-modified") && s.currentHash !== undefined,
  );
  if (force && forceTargets.length > 0) {
    console.warn(
      `WARNING: --force overwrites the remote copy with YOUR local version — ` +
        `remote-only changes to ${forceTargets.length} file(s) will be LOST: ` +
        forceTargets.map((s) => s.entry.path).join(", "),
    );
  }

  const results: PushResult[] = [];
  const syncedAt = new Date().toISOString();
  const spinner = new Spinner();
  let dirty = false;

  for (const state of states) {
    const { entry } = state;
    if (state.status === "unchanged") {
      results.push({ path: entry.path, outcome: "skipped-unchanged" });
      continue;
    }
    if (state.status === "missing-locally") {
      results.push({ path: entry.path, outcome: "missing-locally" });
      continue;
    }
    const overwritesRemote = state.status === "conflict" || state.status === "remote-modified";
    if (overwritesRemote && !force) {
      results.push({
        path: entry.path,
        outcome: state.status === "conflict" ? "conflicted" : "needs-pull",
      });
      continue;
    }
    try {
      const abs = join(projectRoot, entry.path);
      spinner.start(`Uploading ${entry.path} (${entry.size} B)`);
      await backend.push(abs, remoteKeyFor(manifest.projectId, entry.path));
      // currentHash is always set here: computeFileSyncStates hashed this
      // file successfully moments ago (it wasn't missing-locally).
      const content = state.currentHash as string;
      const info = await stat(abs);
      entry.hash = content;
      entry.lastSyncedHash = content;
      entry.lastSyncedAt = syncedAt;
      entry.size = info.size;
      entry.mtimeLocal = info.mtime.toISOString();
      dirty = true;
      results.push({ path: entry.path, outcome: "pushed" });
    } catch (err) {
      results.push({
        path: entry.path,
        outcome: "failed",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  spinner.stop();

  if (dirty) {
    await writeManifest(projectRoot, manifest);
  }

  for (const r of results) {
    console.log(`  ${r.path} — ${OUTCOME_LABEL[r.outcome]}${r.note ? ` (${r.note})` : ""}`);
  }
  const counts = new Map<PushOutcome, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  // Fixed order so the summary doesn't shuffle with file sort order.
  const SUMMARY_ORDER: PushOutcome[] = [
    "pushed",
    "skipped-unchanged",
    "conflicted",
    "needs-pull",
    "missing-locally",
    "failed",
  ];
  const summary: string[] = [];
  for (const outcome of SUMMARY_ORDER) {
    const n = counts.get(outcome);
    if (n) summary.push(`${n} ${OUTCOME_SUMMARY[outcome]}`);
  }
  console.log(`Summary: ${summary.join(", ")}`);

  // Stamp the global registry's lastSyncedAt (what `vsync list` shows) —
  // only when something actually uploaded.
  if (counts.get("pushed")) {
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
  const needsPull = counts.get("needs-pull") ?? 0;
  const failed = counts.get("failed") ?? 0;
  if (conflicts + needsPull + failed > 0) {
    const reasons: string[] = [];
    if (conflicts > 0) reasons.push(`${conflicts} conflicted (needs --force)`);
    if (needsPull > 0) reasons.push(`${needsPull} changed remotely (pull first, or --force)`);
    if (failed > 0) reasons.push(`${failed} failed to upload`);
    throw new Error(
      `Push incomplete — ${reasons.join("; ")}. ` + `The manifest records only successful uploads.`,
    );
  }
}
