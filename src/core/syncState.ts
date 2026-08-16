import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteIndex, RemoteIndexEntry } from "./remoteIndex.js";
import { hashFile } from "./hash.js";
import type { Manifest, ManifestFileEntry } from "./manifest.js";

/**
 * Live two-way comparison shared by `status`, `diff`, `push`, and `pull`:
 * the CURRENT local file (fresh hash) against the CURRENT remote state
 * (the backend sidecar index). Single-user tool — "who changed" is always
 * us, so there are no conflict states: a file either matches or differs,
 * and the push/pull direction decides which side wins.
 */

export type SyncStatus = "unchanged" | "differs" | "missing-locally" | "remote-missing";

export interface FileSyncState {
  entry: ManifestFileEntry;
  status: SyncStatus;
  /** Live local content hash — present whenever the local file exists. */
  currentHash?: string;
  /** Live local byte size (present with currentHash). */
  currentSize?: number;
  /** Live local mtime, ISO date (present with currentHash). */
  localMtime?: string;
  /** The remote index entry — present whenever the backend holds the file. */
  remote?: RemoteIndexEntry;
}

/** Output sections in most-urgent-first order; empty sections are skipped. */
export const STATUS_SECTIONS: { status: SyncStatus; header: string }[] = [
  { status: "differs", header: "Differ (local ≠ remote — push or pull to align):" },
  { status: "missing-locally", header: "Missing locally (pull restores; push deletes remotely):" },
  { status: "remote-missing", header: "Not on remote (never pushed, or deleted there):" },
  { status: "unchanged", header: "In sync:" },
];

/**
 * Categorizes every tracked file of `manifest` against the remote index:
 *
 * - local missing + remote entry → `missing-locally` (pull restores it,
 *   push deletes the remote copy — mirror semantics)
 * - local present + no entry → `remote-missing` (push uploads it)
 * - hashes equal → `unchanged`; else → `differs`
 *
 * `missing-locally` files with no remote entry are reported as
 * `missing-locally` WITHOUT `remote` — nothing exists anywhere; push and
 * pull both skip them.
 */
export async function computeFileSyncStates(
  projectRoot: string,
  manifest: Manifest,
  index: RemoteIndex,
): Promise<FileSyncState[]> {
  const states: FileSyncState[] = [];
  for (const entry of manifest.files) {
    const abs = join(projectRoot, entry.path);
    const info = await stat(abs).catch(() => null);
    const remote = index.files[entry.path];
    if (!info) {
      states.push({ entry, status: "missing-locally", ...(remote ? { remote } : {}) });
      continue;
    }
    const currentHash = await hashFile(abs);
    let status: SyncStatus;
    if (remote === undefined) status = "remote-missing";
    else if (remote.hash === currentHash) status = "unchanged";
    else status = "differs";
    states.push({
      entry,
      status,
      currentHash,
      currentSize: info.size,
      localMtime: info.mtime.toISOString(),
      ...(remote ? { remote } : {}),
    });
  }
  return states;
}
