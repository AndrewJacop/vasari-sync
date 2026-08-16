import { resolveBackend } from "../core/backendResolver.js";
import { readManifest } from "../core/manifest.js";
import { fetchRemoteIndex } from "../core/remoteIndex.js";
import { computeFileSyncStates, STATUS_SECTIONS } from "../core/syncState.js";
import { withSpinner } from "../utils/progress.js";

/**
 * `vsync status` — cheap, read-only live report per tracked file: the
 * CURRENT local content (fresh hash) against the CURRENT remote state
 * (one index fetch from the backend). Paths and statuses only — never
 * file contents or values.
 *
 * `--json` emits `{projectId, backend, files: [{path, status, note?}]}`
 * (status values are the SyncStatus union) instead of the prose sections.
 */
export async function runStatusCommand(
  projectRoot: string,
  homeDir?: string,
  json = false,
): Promise<void> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }
  const backend = await resolveBackend(projectRoot, homeDir);

  const index = (await withSpinner("Fetching remote index", () =>
    fetchRemoteIndex(backend, manifest.projectId),
  )) ?? { files: {} };
  const states = await computeFileSyncStates(projectRoot, manifest, index);

  const byStatus = new Map<string, { path: string; note?: string }[]>();
  for (const { entry, status, remote } of states) {
    // "no local copy either" is the one real extra fact (the file exists
    // nowhere); remote-missing needs no note — the header already says
    // "never pushed, or deleted there" and the model can't tell them apart.
    const note = status === "missing-locally" && !remote ? "no local copy either" : undefined;
    const bucket = byStatus.get(status) ?? [];
    bucket.push({ path: entry.path, note });
    byStatus.set(status, bucket);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          projectId: manifest.projectId,
          backend: manifest.backend,
          files: states.map(({ entry, status, remote }) => ({
            path: entry.path,
            status,
            ...(status === "missing-locally" && !remote ? { note: "no local copy either" } : {}),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `Project '${manifest.projectId}' (backend: ${manifest.backend}) — ${manifest.files.length} tracked file(s)`,
  );
  if (manifest.files.length === 0) {
    console.log("No tracked files yet — use `vsync add <path>` or re-run `vsync init`.");
    return;
  }
  for (const section of STATUS_SECTIONS) {
    const items = byStatus.get(section.status);
    if (!items || items.length === 0) continue;
    console.log("");
    console.log(section.header);
    for (const item of items) {
      console.log(`  ${item.path}${item.note ? ` (${item.note})` : ""}`);
    }
  }
}
