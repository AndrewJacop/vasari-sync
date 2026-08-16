import { confirm } from "@inquirer/prompts";
import { createBackendFromProfile } from "../core/backendResolver.js";
import { readGlobalConfig, upsertProjectEntry, writeGlobalConfig } from "../core/globalConfig.js";
import { readManifest, writeManifest, type ManifestFileEntry } from "../core/manifest.js";
import { fetchRemoteIndex, indexKeyFor } from "../core/remoteIndex.js";
import { ensureVsyncIgnored } from "../utils/paths.js";
import { isNonInteractive } from "../utils/tty.js";
import { runPullCommand } from "./pull.js";

/** Flags for non-interactive `vsync link`. */
export interface LinkCommandOptions {
  /** Pull immediately after linking (the interactive prompt's default). */
  pull?: boolean;
  json?: boolean;
}

/**
 * `vsync link <projectId>` — the machine-B half of the model. The manifest
 * NEVER travels through git (it lists secret paths); instead, a fresh
 * clone rebuilds it from the backend: every remote file under the project
 * prefix becomes a tracked entry, the project joins the local registry,
 * and the user is offered an immediate pull to bring the files down.
 *
 * Entries are just tracked paths — all remote state lives in the backend
 * sidecar index, so a linked clone is immediately diffable (and a pull
 * only overwrites what actually differs).
 */
export async function runLinkCommand(
  projectRoot: string,
  projectId: string,
  homeDir?: string,
  options: LinkCommandOptions = {},
): Promise<void> {
  if (!projectId.trim()) throw new Error("Usage: vsync link <projectId>");

  if ((await readManifest(projectRoot)) !== null) {
    throw new Error(
      "This project already has a .vsync/manifest.json — link would clobber it. " +
        "Delete it first if you really want to re-link from the backend.",
    );
  }

  const global = await readGlobalConfig(homeDir);
  const profileNames = Object.keys(global.profiles);
  if (profileNames.length === 0) {
    throw new Error("No configured backend profiles — run `vsync config` first.");
  }

  // Find the project on any saved profile; first hit wins. Handlers are
  // built with secrets merged in — constructors validate credentials.
  // Preferred source: the sidecar index (exact tracked paths + hashes).
  // Fallback for pre-index backends: the raw file listing, minus the
  // index file itself.
  let backendName: string | undefined;
  let paths: string[] = [];
  const failures: string[] = [];
  for (const name of profileNames) {
    try {
      const backend = createBackendFromProfile(name, global);
      const index = await fetchRemoteIndex(backend, projectId);
      if (index && Object.keys(index.files).length > 0) {
        backendName = name;
        paths = Object.keys(index.files);
        break;
      }
      const listing = await backend.list(`${projectId}/`);
      const listed = listing
        .filter((f) => f.path.startsWith(`${projectId}/`) && !f.path.endsWith("/"))
        .map((f) => f.path.slice(projectId.length + 1))
        .filter((p) => p !== indexKeyFor(projectId).slice(projectId.length + 1));
      if (listed.length > 0) {
        backendName = name;
        paths = listed;
        break;
      }
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (backendName === undefined) {
    throw new Error(
      `No files found for project '${projectId}' on any configured backend ` +
        `(${profileNames.join(", ")}).` +
        (failures.length > 0 ? ` Unreachable profiles: ${failures.join("; ")}.` : ""),
    );
  }

  const files: ManifestFileEntry[] = paths.map((path) => ({ path }));

  await writeManifest(projectRoot, { projectId, backend: backendName, files });
  await ensureVsyncIgnored(projectRoot);
  upsertProjectEntry(global, { projectId, path: projectRoot, backend: backendName });
  await writeGlobalConfig(global, homeDir);

  if (options.json) {
    const filePaths = files.map((f) => f.path);
    const result: Record<string, unknown> = {
      projectId,
      backend: backendName,
      files: filePaths,
    };
    if (options.pull && filePaths.length > 0) {
      // Silent mode: pull prints nothing; its result is embedded here.
      result.pull = await runPullCommand(projectRoot, false, homeDir, "silent");
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `Linked '${projectId}' (backend: ${backendName}) — ${files.length} tracked file(s): ` +
      `${files.map((f) => f.path).join(", ")}.`,
  );
  if (files.length === 0) {
    console.log("Nothing to pull.");
    return;
  }

  if (options.pull) {
    // yes=true: the question above (or the --pull flag) already answered it.
    await runPullCommand(projectRoot, true, homeDir);
  } else if (!isNonInteractive()) {
    if (await confirm({ message: "Pull the files now?", default: true })) {
      await runPullCommand(projectRoot, true, homeDir);
    } else {
      console.log("Run `vsync pull` whenever you're ready.");
    }
  } else {
    // Link succeeded — skipping the pull is not a failure. Non-interactive
    // callers get exit 0 and pull explicitly when they want the files.
    console.log("Run `vsync pull` whenever you're ready.");
  }
}
