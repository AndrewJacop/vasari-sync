import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * One tracked file, as stored in `.vsync/manifest.json`. The manifest is
 * purely the LOCAL list of tracked paths — all hash/state bookkeeping
 * lives in the backend-side index (`core/remoteIndex.ts`), which is the
 * remote's source of truth. Entries from pre-sidecar manifests carried
 * hash/size/mtime fields; those are ignored on read and dropped on the
 * next write.
 */
export interface ManifestFileEntry {
  /** Path relative to the project root, posix-style. */
  path: string;
}

export interface Manifest {
  projectId: string;
  backend: string;
  files: ManifestFileEntry[];
}

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
  let parsed: { projectId?: unknown; backend?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Corrupt manifest at ${manifestPath(projectRoot)} — edit or delete it manually, then re-run.`,
    );
  }
  return {
    projectId: String(parsed.projectId),
    backend: String(parsed.backend),
    files: Array.isArray(parsed.files)
      ? parsed.files.map((f: { path?: unknown }) => ({ path: String(f?.path) }))
      : [],
  };
}

/** Writes the manifest, creating `.vsync/` if needed. */
export async function writeManifest(projectRoot: string, manifest: Manifest): Promise<void> {
  const target = manifestPath(projectRoot);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** Adds an entry (by path); keeps files deterministically sorted. */
export function upsertFileEntry(manifest: Manifest, entry: ManifestFileEntry): void {
  if (!manifest.files.some((f) => f.path === entry.path)) {
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
