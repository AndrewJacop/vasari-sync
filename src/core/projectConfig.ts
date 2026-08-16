import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Per-project config at `.vsync/config.json` — checked into git alongside
 * the manifest, therefore NEVER holds secrets. The guard below enforces that
 * by refusing secret-looking setting names at write time.
 */
export interface ProjectConfig {
  projectId: string;
  backend: string;
  /** Backend-specific non-secret settings (bucket, host, remoteBasePath, ...). */
  settings: Record<string, unknown>;
}

/** Setting names that must never be written to a committed config file. */
const SECRET_SETTING_RE = /(password|passphrase|secret|token|privatekey)/i;

export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".vsync", "config.json");
}

/**
 * Throws if any settings key at any nesting depth looks like a secret.
 * Name-based (can't inspect values meaningfully) — it exists to stop the
 * foot-gun of writing credentials into a git-committed file.
 */
export function assertNoSecretSettings(settings: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_SETTING_RE.test(key)) {
      throw new Error(
        `Refusing to write secret-looking setting '${key}' into .vsync/config.json — it is checked into git. Secrets go in the global config (~/.vsync/config.json) or OS keychain.`,
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertNoSecretSettings(value as Record<string, unknown>);
    }
  }
}

/** Reads the project config; null when the project isn't initialized yet. */
export async function readProjectConfig(projectRoot: string): Promise<ProjectConfig | null> {
  const target = projectConfigPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Corrupt project config at ${target} — edit or delete it manually, then re-run.`,
    );
  }
  return parsed as ProjectConfig;
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  assertNoSecretSettings(config.settings);
  const target = projectConfigPath(projectRoot);
  await mkdir(dirname(target), { recursive: true });
  // No chmod 0600 here: this file is meant to be committed and shared.
  await writeFile(target, JSON.stringify(config, null, 2) + "\n", "utf8");
}
