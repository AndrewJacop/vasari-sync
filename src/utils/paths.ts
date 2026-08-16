import { isAbsolute, relative, resolve, sep } from "node:path";

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
