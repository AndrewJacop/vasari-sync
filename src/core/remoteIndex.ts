import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageBackend } from "../storage/types.js";

/**
 * The remote sidecar index — the backend's source of truth for "what does
 * the remote currently hold". One small JSON file per project, stored ON
 * the backend at `<projectId>/.vsync-index.json`, fetched into memory at
 * command time and never written into the project.
 *
 * Why it exists: backends expose mutually incompatible native change
 * indicators (git blob SHA-1, MD5 etags, opaque etags, none at all), so
 * no cross-backend hash comparison is possible. The index stores OUR
 * sha256 for every pushed file — one hash format everywhere, and
 * status/diff/push/pull need exactly one GET (no per-file downloads, no
 * recursive backend listings) to know the remote state.
 *
 * Entries change ONLY when the remote content changes: push rewrites the
 * index after uploads/deletes; pull/diff/status just read it.
 */

/** One tracked file's remote state, as of its last successful push. */
export interface RemoteIndexEntry {
  /** sha256 of the pushed content ("sha256:<hex>"). */
  hash: string;
  /** Byte size of the pushed content. */
  size: number;
  /** When that content was pushed, ISO date. */
  pushedAt: string;
}

export interface RemoteIndex {
  files: Record<string, RemoteIndexEntry>;
}

export function indexKeyFor(projectId: string): string {
  return `${projectId}/.vsync-index.json`;
}

/** Runs `fn` with a scratch file, cleaning up no matter what. */
async function withScratch<T>(fn: (scratchPath: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "vsync-index-"));
  try {
    return await fn(join(scratch, "index.json"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Fetches the project's index from the backend. Returns null when the
 * backend has none yet (fresh backend, or a pre-sidecar project that
 * hasn't pushed since upgrading) — a fresh backend must diff as
 * "everything not on remote", never as an error.
 */
export async function fetchRemoteIndex(
  backend: StorageBackend,
  projectId: string,
): Promise<RemoteIndex | null> {
  return withScratch(async (tmp) => {
    try {
      await backend.pull(indexKeyFor(projectId), tmp);
    } catch (err) {
      // Every handler reports a missing remote file identically.
      if (/Remote file not found/i.test(err instanceof Error ? err.message : String(err))) {
        return null;
      }
      throw err;
    }
    let parsed: { files?: Record<string, RemoteIndexEntry> };
    try {
      parsed = JSON.parse(await readFile(tmp, "utf8"));
    } catch {
      throw new Error(
        `Remote index for '${projectId}' is corrupt — run \`vsync push\` to rebuild it.`,
      );
    }
    return { files: parsed.files ?? {} };
  });
}

/** Writes the index back to the backend, replacing any previous copy. */
export async function writeRemoteIndex(
  backend: StorageBackend,
  projectId: string,
  index: RemoteIndex,
): Promise<void> {
  await withScratch(async (tmp) => {
    await writeFile(tmp, JSON.stringify(index, null, 2) + "\n");
    await backend.push(tmp, indexKeyFor(projectId));
  });
}
