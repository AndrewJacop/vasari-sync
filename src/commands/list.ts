import { stat } from "node:fs/promises";
import { readGlobalConfig, type ProjectRegistryEntry } from "../core/globalConfig.js";

/**
 * `vsync list` — shows every known project from the global registry.
 * Purely informational: a registered path that no longer exists on disk
 * (moved/removed project) is marked "(missing on disk)" — never an error.
 */
export async function runListCommand(homeDir?: string): Promise<void> {
  const config = await readGlobalConfig(homeDir);
  if (config.projects.length === 0) {
    console.log("No known projects — run `vsync init` inside a project directory first.");
    return;
  }

  console.log(`Known projects (${config.projects.length}):`);
  const idWidth = Math.max(...config.projects.map((p) => p.projectId.length));
  const backendWidth = Math.max(...config.projects.map((p) => p.backend.length));
  for (const project of config.projects) {
    const missing = await pathMissing(project);
    console.log(
      `  ${project.projectId.padEnd(idWidth)}  ${project.backend.padEnd(backendWidth)}  ` +
        `${lastSyncedLabel(project)}  ${project.path}${missing ? "  (missing on disk)" : ""}`,
    );
  }
}

async function pathMissing(project: ProjectRegistryEntry): Promise<boolean> {
  try {
    await stat(project.path);
    return false;
  } catch {
    return true; // Any stat failure (ENOENT, EPERM, ...) reads as missing — listing must not crash.
  }
}

/** Deterministic "2026-08-15 10:22" (no locale dependence); "never" pre-first-sync. */
function lastSyncedLabel(project: ProjectRegistryEntry): string {
  if (!project.lastSyncedAt) return "never synced";
  return project.lastSyncedAt.slice(0, 16).replace("T", " ");
}
