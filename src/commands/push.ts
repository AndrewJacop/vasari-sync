import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { resolveBackend } from "../core/backendResolver.js";
import { readGlobalConfig, upsertProjectEntry, writeGlobalConfig } from "../core/globalConfig.js";
import { readManifest } from "../core/manifest.js";
import { fetchRemoteIndex, writeRemoteIndex, type RemoteIndex } from "../core/remoteIndex.js";
import { computeFileSyncStates, type FileSyncState } from "../core/syncState.js";
import { remoteKeyFor } from "../utils/paths.js";
import { Spinner, withSpinner } from "../utils/progress.js";
import { isNonInteractive } from "../utils/tty.js";

/**
 * `vsync push` — make the remote look like local (mirror semantics).
 *
 * Per-file plan from the live local-vs-index comparison:
 * - unchanged → skipped;
 * - differs / remote-missing → uploaded, remote copy overwritten;
 * - missing-locally WITH a remote copy → DELETED from the backend (the
 *   mirror of a local deletion) and dropped from the index;
 * - missing-locally without a remote copy → nothing anywhere, skipped.
 *
 * Confirm-first: in interactive prose mode the full plan (uploads,
 * overwrites, deletions — with local mtime and remote pushedAt) is shown
 * and must be confirmed before anything transfers. `--yes` (legacy
 * `--force`) skips the prompt; json/silent modes never prompt.
 *
 * The remote index is rewritten once at the end, updated only for files
 * whose transfer succeeded — a failed upload leaves that entry describing
 * the remote copy that is still there, so the index never lies. A partial
 * failure is never all-or-nothing.
 *
 * Output modes: "prose" (default), "json" (one result object on stdout —
 * printed even when the run is incomplete, BEFORE the error, so agents
 * get per-file detail plus exit 1), "silent" (results returned for
 * composition, nothing printed — link uses this).
 */

type PushOutcome =
  "pushed" | "deleted-remotely" | "skipped-unchanged" | "skipped-vanished" | "aborted" | "failed";

/** Per-file line: actionable, states exactly what happened. */
const OUTCOME_LABEL: Record<PushOutcome, string> = {
  pushed: "pushed",
  "deleted-remotely": "deleted on the backend (was missing locally)",
  "skipped-unchanged": "skipped (unchanged)",
  "skipped-vanished": "skipped (no local copy, no remote copy)",
  aborted: "aborted (confirmation declined)",
  failed: "FAILED",
};

/** Totals line: compact versions of the same outcomes. */
const OUTCOME_SUMMARY: Record<PushOutcome, string> = {
  pushed: "pushed",
  "deleted-remotely": "deleted remotely",
  "skipped-unchanged": "skipped (unchanged)",
  "skipped-vanished": "skipped (vanished)",
  aborted: "aborted",
  failed: "failed",
};

interface PushResultFile {
  path: string;
  outcome: PushOutcome;
  note?: string;
}

/** What `vsync push` reports (prose, --json, and link composition). */
export interface PushResult {
  projectId: string;
  backend: string;
  files: PushResultFile[];
  summary: Partial<Record<PushOutcome, number>>;
}

/** Where push/pull results go: prose lines, one JSON object, or nothing. */
export type OutputMode = "prose" | "json" | "silent";

export async function runPushCommand(
  projectRoot: string,
  yes = false,
  homeDir?: string,
  output: OutputMode = "prose",
): Promise<PushResult> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }
  const backend = await resolveBackend(projectRoot, homeDir);

  const index = (await withSpinner("Fetching remote index", () =>
    fetchRemoteIndex(backend, manifest.projectId),
  )) ?? { files: {} };
  const states = await computeFileSyncStates(projectRoot, manifest, index);

  const emptyResult: PushResult = {
    projectId: manifest.projectId,
    backend: manifest.backend,
    files: [],
    summary: {},
  };
  if (manifest.files.length === 0) {
    if (output === "prose") {
      console.log(
        `Project '${manifest.projectId}' (backend: ${manifest.backend}) — 0 tracked file(s)`,
      );
      console.log("No tracked files yet — use `vsync add <path>` or re-run `vsync init`.");
    } else if (output === "json") {
      console.log(JSON.stringify(emptyResult, null, 2));
    }
    return emptyResult;
  }
  if (output === "prose") {
    console.log(
      `Project '${manifest.projectId}' (backend: ${manifest.backend}) — ${manifest.files.length} tracked file(s)`,
    );
  }

  const plan = pushPlan(states);

  // The plan IS the forced diff: nothing transfers until it's confirmed.
  if (
    plan.total() > 0 &&
    !yes &&
    output === "prose" &&
    !isNonInteractive() &&
    !(await confirmPlan("push", plan))
  ) {
    const aborted: PushResultFile[] = plan
      .touched()
      .map((s) => ({ path: s.entry.path, outcome: "aborted" as const }));
    const result = summarize(manifest, aborted);
    console.log("Aborted — nothing was pushed.");
    return result;
  }

  const results: PushResultFile[] = [];
  const pushedAt = new Date().toISOString();
  const spinner = new Spinner();
  const newIndex: RemoteIndex = { files: { ...index.files } };

  for (const state of states) {
    const { entry } = state;
    if (state.status === "unchanged") {
      results.push({ path: entry.path, outcome: "skipped-unchanged" });
      continue;
    }
    if (state.status === "missing-locally") {
      if (!state.remote) {
        results.push({ path: entry.path, outcome: "skipped-vanished" });
        continue;
      }
      try {
        spinner.start(`Deleting ${entry.path} on the backend`);
        await backend.delete(remoteKeyFor(manifest.projectId, entry.path));
        delete newIndex.files[entry.path];
        results.push({ path: entry.path, outcome: "deleted-remotely" });
      } catch (err) {
        results.push({ path: entry.path, outcome: "failed", note: errText(err) });
      }
      continue;
    }
    // differs | remote-missing → upload local, overwriting any remote copy.
    try {
      const abs = join(projectRoot, entry.path);
      spinner.start(`Uploading ${entry.path} (${state.currentSize ?? "?"} B)`);
      await backend.push(abs, remoteKeyFor(manifest.projectId, entry.path));
      // currentHash/currentSize are always set here: the file exists (it
      // wasn't missing-locally) and was just hashed by computeFileSyncStates.
      newIndex.files[entry.path] = {
        hash: state.currentHash as string,
        size: state.currentSize as number,
        pushedAt,
      };
      results.push({ path: entry.path, outcome: "pushed" });
    } catch (err) {
      results.push({ path: entry.path, outcome: "failed", note: errText(err) });
    }
  }

  spinner.stop();

  // Rewrite the index only when the remote actually changed. A write
  // failure after successful transfers leaves the index stale — the next
  // diff simply reports those files as differing again (re-push is a
  // harmless overwrite), so it's reported, never fatal to the result.
  if (results.some((r) => r.outcome === "pushed" || r.outcome === "deleted-remotely")) {
    await withSpinner("Updating remote index", () =>
      writeRemoteIndex(backend, manifest.projectId, newIndex),
    );
  }

  const result = summarize(manifest, results);

  if (output === "prose") {
    for (const r of results) {
      console.log(`  ${r.path} — ${OUTCOME_LABEL[r.outcome]}${r.note ? ` (${r.note})` : ""}`);
    }
    console.log(`Summary: ${summaryLine(result.summary)}`);
  } else if (output === "json") {
    // Printed BEFORE the incomplete error below: agents get the per-file
    // detail on stdout plus exit 1 + stderr error.
    console.log(JSON.stringify(result, null, 2));
  }

  // Stamp the global registry's lastSyncedAt (what `vsync list` shows) —
  // only when something actually transferred.
  if (result.summary.pushed || result.summary["deleted-remotely"]) {
    const global = await readGlobalConfig(homeDir);
    upsertProjectEntry(global, {
      projectId: manifest.projectId,
      path: projectRoot,
      backend: manifest.backend,
      lastSyncedAt: pushedAt,
    });
    await writeGlobalConfig(global, homeDir);
  }

  const failed = result.summary.failed ?? 0;
  if (failed > 0) {
    throw new Error(
      `Push incomplete — ${failed} failed to transfer. ` +
        `The remote index records only successful transfers.`,
    );
  }
  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The actionable subset of states, plus per-bucket listing for the confirm. */
interface PushPlan {
  uploads: FileSyncState[];
  overwrites: FileSyncState[];
  deletions: FileSyncState[];
  total(): number;
  touched(): FileSyncState[];
}

function pushPlan(states: FileSyncState[]): PushPlan {
  const uploads = states.filter((s) => s.status === "remote-missing");
  const overwrites = states.filter((s) => s.status === "differs");
  const deletions = states.filter((s) => s.status === "missing-locally" && s.remote);
  return {
    uploads,
    overwrites,
    deletions,
    total: () => uploads.length + overwrites.length + deletions.length,
    touched: () => [...uploads, ...overwrites, ...deletions],
  };
}

/** Shows the full plan with dates on both sides, then asks. */
async function confirmPlan(direction: string, plan: PushPlan): Promise<boolean> {
  const fmt = (iso: string | undefined): string => (iso ? iso.slice(0, 19).replace("T", " ") : "?");
  if (plan.uploads.length > 0) {
    console.log("Upload (new on the backend):");
    for (const s of plan.uploads)
      console.log(`  ${s.entry.path} (local edited ${fmt(s.localMtime)})`);
  }
  if (plan.overwrites.length > 0) {
    console.log("Upload (OVERWRITE the remote copy — local wins):");
    for (const s of plan.overwrites) {
      console.log(
        `  ${s.entry.path} (local edited ${fmt(s.localMtime)}, remote pushed ${fmt(s.remote?.pushedAt)})`,
      );
    }
  }
  if (plan.deletions.length > 0) {
    console.log("DELETE on the backend (missing locally):");
    for (const s of plan.deletions)
      console.log(`  ${s.entry.path} (remote pushed ${fmt(s.remote?.pushedAt)})`);
  }
  return confirm({ message: `Proceed with ${direction}?`, default: false });
}

function summarize(
  manifest: { projectId: string; backend: string },
  files: PushResultFile[],
): PushResult {
  const counts = new Map<PushOutcome, number>();
  for (const r of files) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  return {
    projectId: manifest.projectId,
    backend: manifest.backend,
    files,
    summary: Object.fromEntries(counts) as Partial<Record<PushOutcome, number>>,
  };
}

/** Fixed order so the summary doesn't shuffle with file sort order. */
function summaryLine(summary: Partial<Record<PushOutcome, number>>): string {
  const ORDER: PushOutcome[] = [
    "pushed",
    "deleted-remotely",
    "skipped-unchanged",
    "skipped-vanished",
    "aborted",
    "failed",
  ];
  const parts: string[] = [];
  for (const outcome of ORDER) {
    const n = summary[outcome];
    if (n) parts.push(`${n} ${OUTCOME_SUMMARY[outcome]}`);
  }
  return parts.join(", ");
}
