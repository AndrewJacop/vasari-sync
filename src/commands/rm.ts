import { readManifest, removeFileEntry, writeManifest } from "../core/manifest.js";
import { toProjectRelativePath } from "../utils/paths.js";

/**
 * `vsync rm <path...>` — untrack files without touching them on disk.
 * Local files are never deleted; copies already pushed to the backend stay
 * there until removed from the backend itself.
 *
 * All-or-nothing: if any listed path isn't tracked, nothing is removed.
 * `--json` emits `{removed: string[]}`.
 */
export async function runRmCommand(
  projectRoot: string,
  paths: string[],
  json = false,
): Promise<void> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }

  const relPaths = [...new Set(paths.map((p) => toProjectRelativePath(projectRoot, p)))];
  const untracked = relPaths.filter((rel) => !manifest.files.some((f) => f.path === rel));
  if (untracked.length > 0) {
    const list = untracked.map((p) => `'${p}'`).join(", ");
    throw new Error(`Not tracked: ${list}. Nothing was removed.`);
  }

  for (const rel of relPaths) removeFileEntry(manifest, rel);
  await writeManifest(projectRoot, manifest);

  if (json) {
    console.log(JSON.stringify({ removed: relPaths }, null, 2));
    return;
  }
  console.log(`Removed ${relPaths.length} file(s) from tracking: ${relPaths.join(", ")}.`);
  console.log(
    "Local files were NOT deleted, and any copies already pushed stay in storage " +
      "until you delete them there.",
  );
}
