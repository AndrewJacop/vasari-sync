import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One tracked file, as stored in `.vsync/manifest.json`. */
export interface ManifestFileEntry {
  /** Path relative to the project root, posix-style. */
  path: string;
  /** Last known hash of the local file ("sha256:<hex>"). */
  hash: string;
  size: number;
  /** Last observed local mtime, ISO date. */
  mtimeLocal: string;
  /** Hash of the version last successfully pushed/pulled. Undefined until first sync. */
  lastSyncedHash?: string;
  /** When that sync happened, ISO date. */
  lastSyncedAt?: string;
}

/** Manifest stored at `.vsync/manifest.json`, checked into git. */
export interface Manifest {
  projectId: string;
  backend: string;
  files: ManifestFileEntry[];
}

export type SyncStatus =
  | "unchanged"
  | "local-modified"
  | "remote-modified"
  | "remote-missing"
  | "conflict";

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, ".vsync", "manifest.json");
}

/** Reads the manifest; returns null when it doesn't exist yet (new project). */
export async function readManifest(projectRoot: string): Promise<Manifest | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(projectRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // A corrupt manifest must fail loudly, not silently reset tracking.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Corrupt manifest at ${manifestPath(projectRoot)} — edit or delete it manually, then re-run.`,
    );
  }
  return parsed as Manifest;
}

/** Writes the manifest, creating `.vsync/` if needed. */
export async function writeManifest(projectRoot: string, manifest: Manifest): Promise<void> {
  const target = manifestPath(projectRoot);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** Adds or replaces (by path) an entry; keeps files deterministically sorted. */
export function upsertFileEntry(manifest: Manifest, entry: ManifestFileEntry): void {
  const existing = manifest.files.find((f) => f.path === entry.path);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    manifest.files.push(entry);
  }
  manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Removes an entry by path. Returns false if it wasn't tracked. */
export function removeFileEntry(manifest: Manifest, path: string): boolean {
  const before = manifest.files.length;
  manifest.files = manifest.files.filter((f) => f.path !== path);
  return manifest.files.length < before;
}

/**
 * Categorizes a tracked file against the backend's current remote hash.
 *
 * Conflict = both sides changed independently since the last successful
 * sync. A never-synced entry (no lastSyncedHash) counts as "changed" on
 * both sides by definition — if a remote copy already exists, that's a
 * genuine both-sides-differ state and push/pull should refuse without
 * --force, which is the safe default.
 */
export function detectConflict(
  entry: ManifestFileEntry,
  remoteCurrentHash: string | undefined,
): SyncStatus {
  if (remoteCurrentHash === undefined) return "remote-missing";
  const localChanged = entry.hash !== entry.lastSyncedHash;
  const remoteChanged = remoteCurrentHash !== entry.lastSyncedHash;
  if (localChanged && remoteChanged) return "conflict";
  if (localChanged) return "local-modified";
  if (remoteChanged) return "remote-modified";
  return "unchanged";
}
