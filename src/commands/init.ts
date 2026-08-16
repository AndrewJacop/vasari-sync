import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { scanCandidates } from "../core/candidateScanner.js";
import { readGlobalConfig, upsertProjectEntry, writeGlobalConfig } from "../core/globalConfig.js";
import { hashFile } from "../core/hash.js";
import { readManifest, writeManifest, type ManifestFileEntry } from "../core/manifest.js";
import { availableBackends, createBackend } from "../storage/registry.js";
import type { BackendConfig } from "../storage/types.js";
import { validateProjectId, ensureVsyncIgnored } from "../utils/paths.js";

/**
 * `vsync init` — first-time setup in a project: pick a project ID and
 * backend, select ignored files worth syncing, then write the manifest and
 * register the project globally. Backend settings/credentials live only in
 * the global profile saved by `vsync config` — nothing machine-specific is
 * written into the project.
 */
export async function runInitCommand(projectRoot: string, homeDir?: string): Promise<void> {
  const globalConfig = await readGlobalConfig(homeDir);

  if ((await readManifest(projectRoot)) !== null) {
    console.warn(
      `[vsync] This project is already initialized. Re-initializing replaces the manifest ` +
        `and the tracked-file list — files you don't re-select are ` +
        `untracked (local files are never deleted).`,
    );
    const proceed = await confirm({ message: "Re-initialize anyway?", default: false });
    if (!proceed) {
      console.log("Aborted — nothing changed.");
      return;
    }
  }

  const projectId = await input({
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

  const backends = availableBackends();
  const backend = await select({
    message: "Which storage backend for this project?",
    choices: backends.map((b) => ({
      name: globalConfig.profiles[b] ? `${b} (saved profile)` : b,
      value: b,
    })),
    default:
      globalConfig.defaultBackend && backends.includes(globalConfig.defaultBackend)
        ? globalConfig.defaultBackend
        : undefined,
  });

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
  const connection = await createBackend(backend, {
    ...profile.settings,
    ...secrets,
  } as BackendConfig).testConnection();
  if (connection.ok) {
    console.log(`Connection OK (${connection.message ?? backend}).`);
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

  // Suppressed candidates never reach the prompt; boosted arrive first and
  // pre-checked (scanCandidates' contract).
  const candidates = (await scanCandidates(projectRoot)).filter(
    (c) => c.classification !== "suppressed",
  );
  const selected: string[] =
    candidates.length === 0
      ? []
      : await checkbox({
          message: "Files to track (suggested files are pre-checked)",
          choices: candidates.map((c) => ({
            value: c.path,
            name: `${c.path} (${c.size} bytes)${c.rule ? ` — matched ${c.rule}` : ""}`,
            checked: c.classification === "boosted",
          })),
        });

  const files: ManifestFileEntry[] = [];
  for (const path of selected) {
    const abs = join(projectRoot, path);
    const info = await stat(abs);
    files.push({
      path,
      hash: await hashFile(abs),
      size: info.size,
      mtimeLocal: info.mtime.toISOString(),
    });
  }

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

  console.log(`Initialized '${projectId}' (backend: ${backend}).`);
  console.log(
    selected.length > 0
      ? `Tracking ${selected.length} file(s): ${selected.join(", ")}. Nothing has been uploaded yet — run \`vsync push\`.`
      : "No files tracked yet — add some later with `vsync add <path>` or re-run `vsync init`.",
  );
}
