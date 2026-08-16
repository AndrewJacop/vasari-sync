import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { resolveBackend } from "../core/backendResolver.js";
import { readGlobalConfig, upsertProjectEntry, writeGlobalConfig } from "../core/globalConfig.js";
import { readManifest } from "../core/manifest.js";
import { fetchRemoteIndex } from "../core/remoteIndex.js";
import { computeFileSyncStates, type FileSyncState } from "../core/syncState.js";
import { remoteKeyFor } from "../utils/paths.js";
import { Spinner, withSpinner } from "../utils/progress.js";
import { isNonInteractive } from "../utils/tty.js";
import type { OutputMode } from "./push.js";

/**
 * `vsync pull` — make local look like the remote (mirror semantics).
 *
 * Per-file plan from the live local-vs-index comparison:
 * - unchanged → skipped;
 * - differs → local file OVERWRITTEN with the remote copy;
 * - missing-locally with a remote copy → restored from the backend;
 * - remote-missing → reported (push to upload it, or `vsync rm` to stop
 *   tracking); never a crash;
 * - missing-locally without a remote copy → nothing anywhere, skipped.
 *
 * Confirm-first (interactive prose mode): overwrites and restores are
 * shown with dates on both sides and must be confirmed before anything
 * downloads. `--yes` skips the prompt; json/silent modes never prompt.
 *
 * Pull never touches the remote index — the remote didn't change.
 *
 * Output modes mirror push: prose (default), json (one result object on
 * stdout, printed BEFORE an incomplete error), silent (link composition).
 */

type PullOutcome =
  | "pulled"
  | "restored"
  | "skipped-unchanged"
  | "skipped-vanished"
  | "missing-remotely"
  | "aborted"
  | "failed";

const OUTCOME_LABEL: Record<PullOutcome, string> = {
  pulled: "pulled (local overwritten)",
  restored: "restored (was missing locally)",
  "skipped-unchanged": "skipped (unchanged)",
  "skipped-vanished": "skipped (no local copy, no remote copy)",
  "missing-remotely": "skipped (no remote copy — push to upload, or `vsync rm` to untrack)",
  aborted: "aborted (confirmation declined)",
  failed: "FAILED",
};

const OUTCOME_SUMMARY: Record<PullOutcome, string> = {
  pulled: "pulled",
  restored: "restored",
  "skipped-unchanged": "skipped (unchanged)",
  "skipped-vanished": "skipped (vanished)",
  "missing-remotely": "skipped (not on remote)",
  aborted: "aborted",
  failed: "failed",
};

interface PullResultFile {
  path: string;
  outcome: PullOutcome;
  note?: string;
}

export interface PullResult {
  projectId: string;
  backend: string;
  files: PullResultFile[];
  summary: Partial<Record<PullOutcome, number>>;
}

export async function runPullCommand(
  projectRoot: string,
  yes = false,
  homeDir?: string,
  output: OutputMode = "prose",
): Promise<PullResult> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }
  const backend = await resolveBackend(projectRoot, homeDir);

  const index = (await withSpinner("Fetching remote index", () =>
    fetchRemoteIndex(backend, manifest.projectId),
  )) ?? { files: {} };
  const states = await computeFileSyncStates(projectRoot, manifest, index);

  const emptyResult: PullResult = {
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

  const overwrites = states.filter((s) => s.status === "differs");
  const restores = states.filter((s) => s.status === "missing-locally" && s.remote);
  const total = overwrites.length + restores.length;

  // The forced pre-flight: nothing downloads until the plan is confirmed.
  if (total > 0 && !yes && output === "prose" && !isNonInteractive()) {
    const fmt = (iso: string | undefined) => (iso ? iso.slice(0, 19).replace("T", " ") : "?");
    if (overwrites.length > 0) {
      console.log("Download (OVERWRITE the local file — remote wins):");
      for (const s of overwrites) {
        console.log(
          `  ${s.entry.path} (local edited ${fmt(s.localMtime)}, remote pushed ${fmt(s.remote?.pushedAt)})`,
        );
      }
    }
    if (restores.length > 0) {
      console.log("Download (restore — file missing locally):");
      for (const s of restores)
        console.log(`  ${s.entry.path} (remote pushed ${fmt(s.remote?.pushedAt)})`);
    }
    if (!(await confirm({ message: "Proceed with pull?", default: false }))) {
      const files: PullResultFile[] = [...overwrites, ...restores].map((s) => ({
        path: s.entry.path,
        outcome: "aborted" as const,
      }));
      const counts = new Map<PullOutcome, number>();
      for (const f of files) counts.set(f.outcome, (counts.get(f.outcome) ?? 0) + 1);
      const result: PullResult = {
        projectId: manifest.projectId,
        backend: manifest.backend,
        files,
        summary: Object.fromEntries(counts) as Partial<Record<PullOutcome, number>>,
      };
      console.log("Aborted — nothing was pulled.");
      return result;
    }
  }

  const results: PullResultFile[] = [];
  const spinner = new Spinner();
  let transferred = 0;

  const attemptPull = async (state: FileSyncState, label: "pulled" | "restored"): Promise<void> => {
    const { entry } = state;
    try {
      spinner.start(`Downloading ${entry.path}…`);
      await backend.pull(
        remoteKeyFor(manifest.projectId, entry.path),
        join(projectRoot, entry.path),
      );
      transferred++;
      results.push({ path: entry.path, outcome: label });
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
    if (state.status === "differs") {
      await attemptPull(state, "pulled");
      continue;
    }
    if (state.status === "missing-locally") {
      if (state.remote) await attemptPull(state, "restored");
      else results.push({ path: entry.path, outcome: "skipped-vanished" });
      continue;
    }
    // remote-missing
    results.push({
      path: entry.path,
      outcome: "missing-remotely",
      note: undefined,
    });
  }

  spinner.stop();

  const counts = new Map<PullOutcome, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const result: PullResult = {
    projectId: manifest.projectId,
    backend: manifest.backend,
    files: results,
    summary: Object.fromEntries(counts) as Partial<Record<PullOutcome, number>>,
  };

  if (output === "prose") {
    for (const r of results) {
      console.log(`  ${r.path} — ${OUTCOME_LABEL[r.outcome]}${r.note ? ` (${r.note})` : ""}`);
    }
    const ORDER: PullOutcome[] = [
      "pulled",
      "restored",
      "skipped-unchanged",
      "missing-remotely",
      "skipped-vanished",
      "aborted",
      "failed",
    ];
    const parts: string[] = [];
    for (const outcome of ORDER) {
      const n = result.summary[outcome];
      if (n) parts.push(`${n} ${OUTCOME_SUMMARY[outcome]}`);
    }
    console.log(`Summary: ${parts.join(", ")}`);
  } else if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
  }

  if (transferred > 0) {
    const global = await readGlobalConfig(homeDir);
    upsertProjectEntry(global, {
      projectId: manifest.projectId,
      path: projectRoot,
      backend: manifest.backend,
      lastSyncedAt: new Date().toISOString(),
    });
    await writeGlobalConfig(global, homeDir);
  }

  const failed = result.summary.failed ?? 0;
  if (failed > 0) {
    throw new Error(`Pull incomplete — ${failed} failed to download.`);
  }
  return result;
}
