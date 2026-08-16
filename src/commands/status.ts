import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveBackend } from "../core/backendResolver.js";
import { hashFile } from "../core/hash.js";
import {
  detectConflict,
  readManifest,
  type ManifestFileEntry,
  type SyncStatus,
} from "../core/manifest.js";
import { remoteKeyFor } from "../utils/paths.js";

/** Everything a tracked file can be, as reported by `vsync status`. */
type LocalStatus = SyncStatus | "missing-locally";

/** Output sections in most-urgent-first order; empty sections are skipped. */
const SECTIONS: { status: LocalStatus; header: string }[] = [
  {
    status: "conflict",
    header: "Conflicts (changed locally AND remotely since last sync — resolve before push/pull):",
  },
  { status: "local-modified", header: "Changed locally (not yet pushed):" },
  { status: "remote-modified", header: "Changed remotely (not yet pulled):" },
  { status: "missing-locally", header: "Missing locally (tracked, but no local file):" },
  {
    status: "remote-missing",
    header: "Missing remotely (not on the backend — never pushed, or deleted there):",
  },
  { status: "unchanged", header: "In sync:" },
];

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

  const byStatus = new Map<LocalStatus, { path: string; note?: string }[]>();
  for (const entry of manifest.files) {
    const abs = join(projectRoot, entry.path);
    const info = await stat(abs).catch(() => null);
    let status: LocalStatus;
    let note: string | undefined;
    if (!info) {
      status = "missing-locally";
    } else {
      // Fresh hash: entry.hash is only as new as the last add/init/push,
      // so it goes stale the moment the user edits the file.
      const current: ManifestFileEntry = { ...entry, hash: await hashFile(abs) };
      const remoteFile = remoteByKey.get(remoteKeyFor(manifest.projectId, entry.path));
      const remoteHash = remoteFile
        ? // Some backends (sftp) list no content hash — then assume
          // "unchanged remotely" once synced; a never-synced entry against
          // an existing remote copy still lands on conflict (safe default).
          (remoteFile.etagOrHash ?? entry.lastSyncedHash ?? entry.hash)
        : undefined;
      status = detectConflict(current, remoteHash);
    }
    if (status === "remote-missing" && entry.lastSyncedHash === undefined) {
      note = "not pushed yet";
    }
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
  for (const section of SECTIONS) {
    const items = byStatus.get(section.status);
    if (!items || items.length === 0) continue;
    console.log("");
    console.log(section.header);
    for (const item of items) {
      console.log(`  ${item.path}${item.note ? ` (${item.note})` : ""}`);
    }
  }
}
