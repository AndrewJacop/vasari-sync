import { confirm } from "@inquirer/prompts";
import { createBackendFromProfile } from "../core/backendResolver.js";
import { readGlobalConfig, upsertProjectEntry, writeGlobalConfig } from "../core/globalConfig.js";
import { readManifest, writeManifest, type ManifestFileEntry } from "../core/manifest.js";
import type { RemoteFile } from "../storage/types.js";
import { ensureVsyncIgnored } from "../utils/paths.js";
import { runPullCommand } from "./pull.js";

/**
 * `vsync link <projectId>` — the machine-B half of the model. The manifest
 * NEVER travels through git (it lists secret paths); instead, a fresh
 * clone rebuilds it from the backend: every remote file under the project
 * prefix becomes a tracked entry, the project joins the local registry,
 * and the user is offered an immediate pull to bring the files down.
 *
 * Entries start with empty hash/mtime ("unknown until pulled") — the
 * follow-up pull stamps real values. If the user declines and local files
 * already exist, sync states read as conflicts until a pull (or --force)
 * resolves them — the safe direction, never a silent overwrite.
 */
export async function runLinkCommand(
  projectRoot: string,
  projectId: string,
  homeDir?: string,
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
  let backendName: string | undefined;
  let remoteFiles: RemoteFile[] = [];
  const failures: string[] = [];
  for (const name of profileNames) {
    try {
      const hits = await createBackendFromProfile(name, global).list(`${projectId}/`);
      if (hits.length > 0) {
        backendName = name;
        remoteFiles = hits;
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

  // Strip the `<projectId>/` prefix. Handlers list files only, but a
  // trailing-slash entry (directory) is dropped defensively.
  const files: ManifestFileEntry[] = remoteFiles
    .filter((f) => f.path.startsWith(`${projectId}/`) && !f.path.endsWith("/"))
    .map((f) => ({
      path: f.path.slice(projectId.length + 1),
      size: f.size,
      hash: "",
      mtimeLocal: "",
    }));

  await writeManifest(projectRoot, { projectId, backend: backendName, files });
  await ensureVsyncIgnored(projectRoot);
  upsertProjectEntry(global, { projectId, path: projectRoot, backend: backendName });
  await writeGlobalConfig(global, homeDir);

  console.log(
    `Linked '${projectId}' (backend: ${backendName}) — ${files.length} tracked file(s): ` +
      `${files.map((f) => f.path).join(", ")}.`,
  );
  if (files.length === 0) {
    console.log("Nothing to pull.");
    return;
  }

  if (await confirm({ message: "Pull the files now?", default: true })) {
    await runPullCommand(projectRoot, false, homeDir);
  } else {
    console.log("Run `vsync pull` whenever you're ready.");
  }
}
