import { isAbsolute, relative, resolve, sep } from "node:path";

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
 * Converts a user-supplied path (relative or absolute, any separator style)
 * to the project-relative posix-style string used in manifests and remote
 * keys. Throws when the path points outside the project root — tracked
 * files must live inside the project.
 */
export function toProjectRelativePath(projectRoot: string, input: string): string {
  const abs = resolve(projectRoot, input);
  const rel = relative(projectRoot, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`'${input}' is outside the project root — tracked files must live inside it.`);
  }
  return rel.split(sep).join("/");
}
