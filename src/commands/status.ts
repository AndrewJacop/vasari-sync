import { resolveBackend } from "../core/backendResolver.js";
import { computeFileSyncStates, STATUS_SECTIONS } from "../core/syncState.js";
import { readManifest } from "../core/manifest.js";

/**
 * `vsync status` — cheap, read-only report per tracked file: local state
 * (fresh hash vs. last synced) crossed with the backend's current state
 * (one `list()` call, scoped to this project's key prefix). Paths and
 * statuses only — never file contents or values.
 */
export async function runStatusCommand(projectRoot: string, homeDir?: string): Promise<void> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }
  const backend = await resolveBackend(projectRoot, homeDir);

  // One listing covers every tracked file; the projectId prefix scopes it
  // (server-side filtering on S3, walk-filter elsewhere).
  const remoteByKey = new Map(
    (await backend.list(`${manifest.projectId}/`)).map((f) => [f.path, f]),
  );
  const states = await computeFileSyncStates(projectRoot, manifest, remoteByKey);

  const byStatus = new Map<string, { path: string; note?: string }[]>();
  for (const { entry, status } of states) {
    const note =
      status === "remote-missing" && entry.lastSyncedHash === undefined
        ? "not pushed yet"
        : undefined;
    const bucket = byStatus.get(status) ?? [];
    bucket.push({ path: entry.path, note });
    byStatus.set(status, bucket);
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
