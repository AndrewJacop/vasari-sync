import { confirm, input, select } from "@inquirer/prompts";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { scanCandidates } from "../core/candidateScanner.js";
import { readGlobalConfig, upsertProjectEntry, writeGlobalConfig } from "../core/globalConfig.js";
import { readManifest, writeManifest, type ManifestFileEntry } from "../core/manifest.js";
import { availableBackends, createBackend } from "../storage/registry.js";
import type { BackendConfig } from "../storage/types.js";
import { validateProjectId, ensureVsyncIgnored, toProjectRelativePath } from "../utils/paths.js";
import { withSpinner } from "../utils/progress.js";
import { isNonInteractive } from "../utils/tty.js";
import { treeCheckbox } from "../utils/treeCheckbox.js";

/** Flags for non-interactive `vsync init` (agents/CI/extension). */
export interface InitCommandOptions {
  projectId?: string;
  backend?: string;
  /** Repeatable; each value may itself be comma-separated. */
  files?: string[];
  /** Re-initialize despite an existing manifest. */
  yes?: boolean;
  /** Print candidate files (same scan as the picker) and exit. */
  list?: boolean;
  json?: boolean;
}

/**
 * `vsync init` — first-time setup in a project: pick a project ID and
 * backend, select ignored files worth syncing, then write the manifest and
 * register the project globally. Backend settings/credentials live only in
 * the global profile saved by `vsync config` — nothing machine-specific is
 * written into the project.
 *
 * Every prompt has a flag twin (`--project-id`, `--backend`, `--files`,
 * `--yes`); with no TTY the missing flag either has a safe default
 * (project ID ← folder name, backend ← global default, files ← none) or
 * fails fast naming the flag. `--list` is the agent-facing discovery step:
 * the candidate scan without any manifest write.
 */
export async function runInitCommand(
  projectRoot: string,
  options: InitCommandOptions = {},
  homeDir?: string,
): Promise<void> {
  if (options.list) return listCandidates(projectRoot, options.json === true);

  const globalConfig = await readGlobalConfig(homeDir);

  // ── Existing manifest: replace or refuse ─────────────────────────────
  if ((await readManifest(projectRoot)) !== null) {
    console.warn(
      `[vsync] This project is already initialized. Re-initializing replaces the manifest ` +
        `and the tracked-file list — files you don't re-select are ` +
        `untracked (local files are never deleted).`,
    );
    let proceed: boolean;
    if (options.yes) proceed = true;
    else if (!isNonInteractive())
      proceed = await confirm({ message: "Re-initialize anyway?", default: false });
    else
      throw new Error(
        "Project already initialized — pass --yes to re-initialize (the manifest and tracked-file list are replaced).",
      );
    if (!proceed) {
      console.log("Aborted — nothing changed.");
      return;
    }
  }

  // ── Project ID: flag → prompt (TTY) → folder name (non-interactive) ──
  let projectId: string;
  if (options.projectId !== undefined) {
    const idCheck = validateProjectId(options.projectId);
    if (idCheck !== true) throw new Error(idCheck);
    const clash = globalConfig.projects.find(
      (p) => p.projectId === options.projectId && p.path !== projectRoot,
    );
    if (clash)
      throw new Error(
        `'${options.projectId}' is already registered for another project (${clash.path}) — pick a unique ID`,
      );
    projectId = options.projectId;
  } else if (!isNonInteractive()) {
    projectId = await input({
      message: "Project ID",
      default: basename(projectRoot),
      validate: (v: string) => {
        const idCheck = validateProjectId(v);
        if (idCheck !== true) return idCheck;
        const clash = globalConfig.projects.find(
          (p) => p.projectId === v.trim() && p.path !== projectRoot,
        );
        if (clash)
          return `'${v.trim()}' is already registered for another project (${clash.path}) — pick a unique ID`;
        return true;
      },
    });
  } else {
    projectId = basename(projectRoot); // same default the prompt offers
  }

  // ── Backend: flag → prompt (TTY) → global default (non-interactive) ──
  let backend: string;
  if (options.backend !== undefined) {
    if (!availableBackends().includes(options.backend))
      throw new Error(
        `Unknown backend '${options.backend}', available: ${availableBackends().join(", ")}.`,
      );
    backend = options.backend;
  } else if (!isNonInteractive()) {
    backend = await select({
      message: "Which storage backend for this project?",
      choices: availableBackends().map((b) => ({
        name: globalConfig.profiles[b] ? `${b} (saved profile)` : b,
        value: b,
      })),
      default:
        globalConfig.defaultBackend && availableBackends().includes(globalConfig.defaultBackend)
          ? globalConfig.defaultBackend
          : undefined,
    });
  } else if (globalConfig.defaultBackend) {
    backend = globalConfig.defaultBackend;
  } else {
    throw new Error(
      `Non-interactive init: no default backend configured — pass --backend <name> (available: ${availableBackends().join(", ")}).`,
    );
  }

  const profile = globalConfig.profiles[backend];
  if (!profile) {
    throw new Error(
      `No saved profile for '${backend}' — run \`vsync config\` first to configure its settings and credentials.`,
    );
  }

  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalConfig.secrets)) {
    if (key.startsWith(`${backend}/`)) secrets[key.slice(backend.length + 1)] = value;
  }
  const connection = await withSpinner("Testing connection", () =>
    createBackend(backend, {
      ...profile.settings,
      ...secrets,
    } as BackendConfig).testConnection(),
  );
  if (connection.ok) {
    console.log(`Connection OK (${connection.message ?? backend}).`);
  } else if (isNonInteractive()) {
    throw new Error(
      `Connection test failed: ${connection.message ?? "unknown error"} — init aborted (nothing changed). Fix the profile with \`vsync config\` and retry.`,
    );
  } else {
    const proceed = await confirm({
      message: `Connection test failed: ${connection.message ?? "unknown error"}. Continue anyway?`,
      default: false,
    });
    if (!proceed) {
      console.log("Aborted — nothing changed.");
      return;
    }
  }

  // ── Files: flag (comma-split) → picker (TTY) → none (non-interactive) ─
  // Suppressed candidates never reach the prompt; boosted arrive pre-checked
  // (scanCandidates' contract). Tree prompt: folders toggle whole subtrees,
  // nested-repo folders are tagged (see candidateScanner). Flag mode accepts
  // any existing project file — the agent may know better than the scorer.
  let selected: string[];
  if (options.files !== undefined) {
    selected = await validateFlagFiles(projectRoot, options.files);
  } else if (!isNonInteractive()) {
    const candidates = (await scanCandidates(projectRoot)).filter(
      (c) => c.classification !== "suppressed",
    );
    selected =
      candidates.length === 0 ? [] : await treeCheckbox({ message: "Files to track", candidates });
  } else {
    selected = [];
  }

  const files: ManifestFileEntry[] = selected.map((path) => ({ path }));

  await writeManifest(projectRoot, { projectId, backend, files });
  // The manifest lists secret paths — it must never reach git. Cross-device
  // bootstrap is `vsync link`, which rebuilds it from the backend.
  await ensureVsyncIgnored(projectRoot);
  // Explicit undefined keeps a stale timestamp from surviving re-init.
  upsertProjectEntry(globalConfig, {
    projectId,
    path: projectRoot,
    backend,
    lastSyncedAt: undefined,
  });
  await writeGlobalConfig(globalConfig, homeDir);

  if (options.json) {
    console.log(JSON.stringify({ projectId, backend, files: selected }, null, 2));
    return;
  }
  console.log(`Initialized '${projectId}' (backend: ${backend}).`);
  console.log(
    selected.length > 0
      ? `Tracking ${selected.length} file(s): ${selected.join(", ")}. Nothing has been uploaded yet — run \`vsync push\`.`
      : "No files tracked yet — add some later with `vsync add <path>` or re-run `vsync init`.",
  );
}

/** `init --list`: the candidate scan, printed, no manifest write.
 * Works pre-init — it's the discovery step before deciding `--files`. */
async function listCandidates(projectRoot: string, json: boolean): Promise<void> {
  const candidates = (await scanCandidates(projectRoot)).filter(
    (c) => c.classification !== "suppressed",
  );
  if (json) {
    console.log(
      JSON.stringify(
        {
          candidates: candidates.map((c) => ({
            path: c.path,
            size: c.size,
            classification: c.classification,
            ...(c.rule ? { rule: c.rule } : {}),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (candidates.length === 0) {
    console.log("No candidate files found (gitignored files worth syncing).");
    return;
  }
  console.log("Candidate files (same scan as `vsync init`):");
  for (const c of candidates) {
    const tag = c.classification === "boosted" ? ` — suggested (${c.rule})` : "";
    console.log(`  ${c.path} (${c.size} bytes)${tag}`);
  }
}

/** Normalizes + validates `--files` values: each entry may be
 * comma-separated; every path must be an existing regular file inside the
 * project. All-or-nothing (same contract as `vsync add`). */
async function validateFlagFiles(projectRoot: string, raw: string[]): Promise<string[]> {
  const relPaths = [
    ...new Set(raw.flatMap((v) => v.split(",")).map((p) => toProjectRelativePath(projectRoot, p))),
  ].filter((p) => p !== "");
  const errors: string[] = [];
  for (const rel of relPaths) {
    const info = await stat(join(projectRoot, rel)).catch(() => null);
    if (!info) errors.push(`'${rel}' does not exist`);
    else if (!info.isFile()) errors.push(`'${rel}' is not a regular file`);
  }
  if (errors.length > 0)
    throw new Error(`Cannot track --files: ${errors.join("; ")}. Nothing was initialized.`);
  return relPaths;
}
