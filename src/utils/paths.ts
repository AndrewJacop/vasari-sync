import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * A project ID becomes a directory segment in every remote key, so it
 * must be a single safe segment: no path separators (they desync push
 * keys from list keys when a backend collapses them) and no "."/".."
 * (join() collapses those segments away, same desync). Other characters
 * (spaces, unicode, ":") stay legal — real backends accept them.
 */
export function validateProjectId(value: string): true | string {
  const trimmed = value.trim();
  if (!trimmed) return "Project ID is required";
  if (/[\\/]/.test(trimmed)) {
    return "Project ID must not contain '/' or '\\' — it names a directory in remote keys";
  }
  if (trimmed === "." || trimmed === "..") {
    return "'.' and '..' collapse inside remote keys — pick a real project ID";
  }
  return true;
}

/**
 * Remote key layout shared by every command: "<projectId>/<project-relative
 * path>" (posix-style — project-relative paths already are). The projectId
 * directory keeps separate projects sharing one backend profile from
 * overwriting each other's files, and lets a fresh clone derive every key
 * from its manifest alone.
 */
export function remoteKeyFor(projectId: string, relPath: string): string {
  return `${projectId}/${relPath}`;
}

/**
 * Keeps `.vsync/` out of git: the manifest lists secret file paths, so it
 * must never ride a `git push` (cross-device bootstrap is `vsync link`,
 * which rebuilds the manifest from the backend). Appends the ignore
 * line when missing; idempotent, never throws for a missing .gitignore
 * (appendFile creates it — harmless in non-git directories).
 */
export async function ensureVsyncIgnored(projectRoot: string): Promise<void> {
  const gitignore = join(projectRoot, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(gitignore, "utf8");
  } catch {
    // No .gitignore yet — the append below creates one.
  }
  if (existing.split(/\r?\n/).some((l) => l.trim() === ".vsync" || l.trim() === ".vsync/")) return;
  await appendFile(gitignore, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}.vsync/\n`);
}
export function toProjectRelativePath(projectRoot: string, input: string): string {
  const abs = resolve(projectRoot, input);
  const rel = relative(projectRoot, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`'${input}' is outside the project root — tracked files must live inside it.`);
  }
  return rel.split(sep).join("/");
}
