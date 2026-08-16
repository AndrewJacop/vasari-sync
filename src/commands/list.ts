import { stat } from "node:fs/promises";
import { readGlobalConfig, type ProjectRegistryEntry } from "../core/globalConfig.js";
import { createBackendFromProfile } from "../core/backendResolver.js";

/**
 * `vsync list` — projects found on the configured backends (one full
 * listing per profile, grouped by `<projectId>/` top-level prefix), so a
 * fresh machine sees every project ever pushed, not just ones it linked.
 * The local registry enriches rows with the checkout path and last-sync
 * time; registry-only projects (never pushed, or deleted on the backend)
 * stay listed with a marker. Purely informational — unreachable profiles
 * are warned about, never fatal.
 *
 * `--json` emits `{projects: [...], unreachable: string[]}` instead of
 * the aligned table.
 */
export async function runListCommand(homeDir?: string, json = false): Promise<void> {
  const global = await readGlobalConfig(homeDir);

  // projectId -> { backend profile, file count }, from every profile's listing.
  const remote = new Map<string, { backend: string; files: number }>();
  const failures: string[] = [];
  for (const name of Object.keys(global.profiles)) {
    try {
      for (const file of await createBackendFromProfile(name, global).list()) {
        // Skip the sidecar index — it's vsync bookkeeping, not a synced file.
        if (file.path.endsWith("/.vsync-index.json")) continue;
        const id = file.path.split("/")[0];
        // Top-level segments are project IDs; stray root files / dir
        // entries (trailing slash) are not projects.
        if (!id || !file.path.includes("/") || file.path.endsWith("/")) continue;
        const hit = remote.get(id);
        if (hit) hit.files += 1;
        else remote.set(id, { backend: name, files: 1 });
      }
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }

  const registry = new Map(global.projects.map((p) => [p.projectId, p]));
  const ids = [...new Set([...remote.keys(), ...registry.keys()])].sort();

  if (json) {
    const projects = await Promise.all(
      ids.map(async (id) => {
        const onBackend = remote.get(id);
        const entry = registry.get(id);
        return {
          projectId: id,
          backend: onBackend?.backend ?? entry!.backend,
          fileCount: onBackend?.files ?? null,
          linked: entry !== undefined,
          ...(entry
            ? {
                path: entry.path,
                lastSyncedAt: entry.lastSyncedAt ?? null,
                missingOnDisk: await pathMissing(entry),
              }
            : {}),
        };
      }),
    );
    console.log(JSON.stringify({ projects, unreachable: failures }, null, 2));
    return;
  }

  // File count `—` means: no configured backend currently holds this project
  // (never pushed, deleted remotely, or nothing configured). No extra marker.
  if (ids.length === 0) {
    if (Object.keys(global.profiles).length === 0) {
      console.log("No known projects — run `vsync init` inside a project directory first.");
    } else {
      console.log(
        "No projects on your backends yet — nothing has been pushed. " +
          "Run `vsync init` + `vsync push` inside a project on a machine that has the files.",
      );
    }
    return;
  }

  console.log(`Known projects (${ids.length}):`);
  const idWidth = Math.max(...ids.map((id) => id.length));
  const backendWidth = Math.max(
    ...ids.map((id) => (remote.get(id)?.backend ?? registry.get(id)!.backend).length),
  );
  for (const id of ids) {
    const onBackend = remote.get(id);
    const entry = registry.get(id);
    const backend = onBackend?.backend ?? entry!.backend;
    const files = onBackend ? `${onBackend.files} file${onBackend.files === 1 ? "" : "s"}` : "—";

    let tail: string;
    if (entry) {
      const missing = await pathMissing(entry);
      tail = `${lastSyncedLabel(entry)}  ${entry.path}${missing ? "  (missing on disk)" : ""}`;
    } else {
      tail = `not linked here — run \`vsync link ${id}\``;
    }

    console.log(`  ${id.padEnd(idWidth)}  ${backend.padEnd(backendWidth)}  ${files}  ${tail}`);
  }

  for (const failure of failures) {
    console.warn(`[vsync] Unreachable backend profile, skipped: ${failure}`);
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
