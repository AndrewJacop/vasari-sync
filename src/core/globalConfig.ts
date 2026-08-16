import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * KEYCHAIN DECISION (required by plan Task 2): we do NOT use `keytar`.
 * keytar (atom/node-keytar) is unmaintained — repo archived Dec 2022, last
 * release 7.9.0 (Feb 2022), a native node-gyp module with no prebuilds for
 * modern Node (its own former users, e.g. Microsoft Azure Storage Explorer,
 * dropped it). Rather than bet v1 on an unproven replacement, we use the
 * plan-sanctioned fallback: secrets live in `~/.vsync/config.json` with 0600
 * permissions and the user is warned exactly once (see setSecret). Moving to
 * a real keychain later means re-pointing getSecret/setSecret only — nothing
 * else reads the `secrets` map.
 */

/** One known project, as shown by `vsync list`. */
export interface ProjectRegistryEntry {
  projectId: string;
  path: string;
  backend: string;
  lastSyncedAt?: string;
}

/** A saved backend profile — non-secret settings only. */
export interface BackendProfile {
  /** Backend type, e.g. "s3". */
  backend: string;
  /** Backend-specific non-secret settings (bucket, host, remoteBasePath, ...). */
  settings: Record<string, unknown>;
}

export interface GlobalConfig {
  defaultBackend?: string;
  /** Saved profiles, keyed by profile name. */
  profiles: Record<string, BackendProfile>;
  /**
   * Fallback secret store, keyed "<profile>/<field>"
   * (e.g. "main/secretAccessKey"). Kept in a separate top-level map (not
   * inside profiles) so a future keychain can replace just this map.
   */
  secrets: Record<string, string>;
  /** Known projects for `vsync list`. */
  projects: ProjectRegistryEntry[];
  /** Set after the one-time fallback warning has been shown to the user. */
  secretsFallbackNotified?: boolean;
}

/**
 * Explicit homeDir wins; otherwise VSYNC_HOME lets tests / spawned CLI
 * processes redirect the config root; otherwise the real home directory.
 */
export function globalConfigPath(homeDir?: string): string {
  return join(homeDir ?? process.env.VSYNC_HOME ?? homedir(), ".vsync", "config.json");
}

export async function readGlobalConfig(homeDir?: string): Promise<GlobalConfig> {
  const target = globalConfigPath(homeDir);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { profiles: {}, secrets: {}, projects: [] };
    }
    throw err;
  }
  // Corrupt config must fail loudly: it holds the registry and secrets, so
  // silently resetting it would be data loss.
  let parsed: Partial<GlobalConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<GlobalConfig>;
  } catch {
    throw new Error(
      `Corrupt global config at ${target} — edit or delete it manually, then re-run.`,
    );
  }
  return {
    ...parsed,
    profiles: parsed.profiles ?? {},
    secrets: parsed.secrets ?? {},
    projects: parsed.projects ?? [],
  };
}

export async function writeGlobalConfig(config: GlobalConfig, homeDir?: string): Promise<void> {
  const target = globalConfigPath(homeDir);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(config, null, 2) + "\n", "utf8");
  try {
    await chmod(target, 0o600); // Owner-only on POSIX; harmless no-op-ish on Windows.
  } catch {
    // Platforms without chmod support must not fail the whole write.
  }
}

/** Adds or replaces a registry entry by projectId — never duplicates. */
export function upsertProjectEntry(config: GlobalConfig, entry: ProjectRegistryEntry): void {
  const existing = config.projects.find((p) => p.projectId === entry.projectId);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    config.projects.push(entry);
  }
}

export function secretKey(profile: string, field: string): string {
  return `${profile}/${field}`;
}

/** Stores a secret in the fallback store, warning about the fallback exactly once. */
export async function setSecret(
  profile: string,
  field: string,
  value: string,
  homeDir?: string,
): Promise<void> {
  const config = await readGlobalConfig(homeDir);
  config.secrets[secretKey(profile, field)] = value;
  if (!config.secretsFallbackNotified) {
    console.warn(
      `[vsync] No OS keychain integration is used — secrets are stored in ${globalConfigPath(homeDir)} (0600). Treat that file like an SSH private key.`,
    );
    config.secretsFallbackNotified = true;
  }
  await writeGlobalConfig(config, homeDir);
}

export async function getSecret(
  profile: string,
  field: string,
  homeDir?: string,
): Promise<string | undefined> {
  const config = await readGlobalConfig(homeDir);
  return config.secrets[secretKey(profile, field)];
}
