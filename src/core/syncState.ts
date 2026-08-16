import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteFile } from "../storage/types.js";
import { remoteKeyFor } from "../utils/paths.js";
import { hashFile } from "./hash.js";
import {
  detectConflict,
  type Manifest,
  type ManifestFileEntry,
  type SyncStatus,
} from "./manifest.js";

/**
 * Per-file sync categorization shared by `status`, `diff`, and (soon)
 * `push`/`pull`: fresh local hash crossed with the backend's current state
 * from ONE `list()` call. Kept here so every command agrees on what
 * "conflict" means.
 */

/** Everything a tracked file can be, as reported by status/diff. */
export type LocalStatus = SyncStatus | "missing-locally";

export interface FileSyncState {
  entry: ManifestFileEntry;
  status: LocalStatus;
  /** The backend's listing for this file, if one exists. */
  remoteFile?: RemoteFile;
}

/** Output sections in most-urgent-first order; empty sections are skipped. */
export const STATUS_SECTIONS: { status: LocalStatus; header: string }[] = [
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
 * Categorizes every tracked file of `manifest` against the backend listing
 * `remoteByKey` (keyed by remote key — build it from one
 * `backend.list(\`${projectId}/\`)` call). A missing local file is
 * reported as-is; otherwise the hash is re-read from disk because
 * `entry.hash` is a record of the last add/init/sync, not a live view.
 */
export async function computeFileSyncStates(
  projectRoot: string,
  manifest: Manifest,
  remoteByKey: Map<string, RemoteFile>,
): Promise<FileSyncState[]> {
  const states: FileSyncState[] = [];
  for (const entry of manifest.files) {
    const abs = join(projectRoot, entry.path);
    const info = await stat(abs).catch(() => null);
    if (!info) {
      states.push({ entry, status: "missing-locally" });
      continue;
    }
    const current: ManifestFileEntry = { ...entry, hash: await hashFile(abs) };
    const remoteFile = remoteByKey.get(remoteKeyFor(manifest.projectId, entry.path));
    const remoteHash = remoteFile
      ? // Some backends (sftp) list no content hash — then assume
        // "unchanged remotely" once synced; a never-synced entry against
        // an existing remote copy still lands on conflict (safe default).
        (remoteFile.etagOrHash ?? entry.lastSyncedHash ?? entry.hash)
      : undefined;
    states.push({ entry, status: detectConflict(current, remoteHash), remoteFile });
  }
  return states;
}
