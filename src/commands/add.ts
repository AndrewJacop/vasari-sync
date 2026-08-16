import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readManifest, upsertFileEntry, writeManifest } from "../core/manifest.js";
import { toProjectRelativePath } from "../utils/paths.js";

/**
 * `vsync add <path...>` — track files individually, outside the `init`
 * flow. Manifest-only change: nothing is uploaded (`vsync push` does that)
 * and local files are left exactly as they are.
 *
 * All-or-nothing: every path is validated before any entry is written, so
 * one bad path can't leave a half-updated manifest behind. `--json` emits
 * `{added: string[]}`.
 */
export async function runAddCommand(
  projectRoot: string,
  paths: string[],
  json = false,
): Promise<void> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error("No .vsync/manifest.json found — run `vsync init` in this project first.");
  }

  const relPaths = [...new Set(paths.map((p) => toProjectRelativePath(projectRoot, p)))];
  const errors: string[] = [];
  for (const rel of relPaths) {
    if (manifest.files.some((f) => f.path === rel)) {
      errors.push(`'${rel}' is already tracked`);
      continue;
    }
    const info = await stat(join(projectRoot, rel)).catch(() => null);
    if (!info) errors.push(`'${rel}' does not exist`);
    else if (!info.isFile()) errors.push(`'${rel}' is not a regular file`);
  }
  if (errors.length > 0) {
    throw new Error(`Cannot add: ${errors.join("; ")}. Nothing was added.`);
  }

  for (const rel of relPaths) {
    await stat(join(projectRoot, rel)); // existence + regular-file check
    upsertFileEntry(manifest, { path: rel });
  }
  await writeManifest(projectRoot, manifest);

  if (json) {
    console.log(JSON.stringify({ added: relPaths }, null, 2));
    return;
  }
  console.log(`Added ${relPaths.length} file(s) to tracking: ${relPaths.join(", ")}.`);
  console.log("Nothing was uploaded — run `vsync push` to sync tracked files.");
}
