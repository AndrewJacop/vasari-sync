#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runAddCommand } from "./commands/add.js";
import { runConfigCommand } from "./commands/config.js";
import { runInitCommand } from "./commands/init.js";
import { runLinkCommand } from "./commands/link.js";
import { runRmCommand } from "./commands/rm.js";
import { runDiffCommand } from "./commands/diff.js";
import { runStatusCommand } from "./commands/status.js";
import { runPushCommand } from "./commands/push.js";
import { runPullCommand } from "./commands/pull.js";
import { runListCommand } from "./commands/list.js";
import { runUpdateCommand } from "./commands/update.js";

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("vsync")
  .description(
    "Sync non-VCS project files (.env, secrets, local config) to storage you already own",
  )
  .version(readVersion());

program
  .command("config")
  .description("Set up storage backend + credentials")
  .option("--show", "print current config with secrets redacted")
  .option("--set-default <backend>", "set the default backend without prompts")
  .option("--backend <name>", "non-interactive: backend to configure (see `vsync config --show`)")
  .option(
    "--set <key=value>",
    "non-interactive: set a backend setting (repeatable)",
    (v: string, prev: string[]) => prev.concat(v),
    [],
  )
  .option(
    "--secret <key=value>",
    "non-interactive: set a secret (repeatable; prefer VSYNC_SECRET_* env vars)",
    (v: string, prev: string[]) => prev.concat(v),
    [],
  )
  .option("--json", "machine-readable output")
  .action(async (options) => {
    try {
      await runConfigCommand(options);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("init")
  .description("Set up this project: pick files to track and a storage backend")
  .option("--project-id <id>", "non-interactive: project ID (default: folder name)")
  .option("--backend <name>", "non-interactive: backend for this project (default: global default)")
  .option(
    "--files <paths>",
    "non-interactive: comma-separated project-relative file paths to track (repeatable)",
    (v: string, prev: string[]) => prev.concat(v),
    [],
  )
  .option("--yes", "re-initialize despite an existing manifest")
  .option("--list", "print candidate files (same scan as the picker) and exit")
  .option("--json", "machine-readable output")
  .action(async (options) => {
    try {
      await runInitCommand(process.cwd(), options);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("add")
  .description("Track file(s) for syncing (manifest only — nothing is uploaded)")
  .argument("<path...>", "file path(s) inside the project")
  .option("--json", "machine-readable output")
  .action(async (paths: string[], options: { json?: boolean }) => {
    try {
      await runAddCommand(process.cwd(), paths, options.json === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("rm")
  .description("Stop tracking file(s) — local files are NOT deleted")
  .argument("<path...>", "tracked file path(s)")
  .option("--json", "machine-readable output")
  .action(async (paths: string[], options: { json?: boolean }) => {
    try {
      await runRmCommand(process.cwd(), paths, options.json === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Show sync status of tracked files (paths and statuses only)")
  .option("--json", "machine-readable output")
  .action(async (options: { json?: boolean }) => {
    try {
      await runStatusCommand(process.cwd(), undefined, options.json === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("diff")
  .description("Show differences between local files and the backend copy")
  .option("--show-values", "include full content diffs (prints actual file values)")
  .option("--json", "machine-readable output")
  .action(async (options: { showValues?: boolean; json?: boolean }) => {
    try {
      await runDiffCommand(
        process.cwd(),
        options.showValues === true,
        undefined,
        options.json === true,
      );
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("push")
  .description("Upload tracked files that changed since the last sync")
  .option("-f, --force", "overwrite remote-only changes (local version wins)")
  .option("--json", "machine-readable output")
  .action(async (options: { force?: boolean; json?: boolean }) => {
    try {
      await runPushCommand(
        process.cwd(),
        options.force === true,
        undefined,
        options.json === true ? "json" : "prose",
      );
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("pull")
  .description("Download tracked files that changed on the backend since the last sync")
  .option("-f, --force", "overwrite local-only changes (remote version wins)")
  .option("--json", "machine-readable output")
  .action(async (options: { force?: boolean; json?: boolean }) => {
    try {
      await runPullCommand(
        process.cwd(),
        options.force === true,
        undefined,
        options.json === true ? "json" : "prose",
      );
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .description("Show all known projects (on your backends and linked on this machine)")
  .option("--json", "machine-readable output")
  .action(async (options: { json?: boolean }) => {
    try {
      await runListCommand(undefined, options.json === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("update")
  .description("Update vasari-sync to the latest version from npm")
  .option("-y, --yes", "install the new version without asking")
  .option("--json", "machine-readable output")
  .action(async (options: { yes?: boolean; json?: boolean }) => {
    try {
      await runUpdateCommand(options.yes === true, options.json === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("link")
  .description(
    "Adopt an existing backend project into this clone: rebuild the manifest from the backend and optionally pull",
  )
  .argument("<projectId>", "project ID (see `vsync list` on the machine that pushed)")
  .option(
    "--pull",
    "pull the files immediately after linking (default: ask, or skip when non-interactive)",
  )
  .option("--json", "machine-readable output")
  .action(async (projectId: string, options: { pull?: boolean; json?: boolean }) => {
    try {
      await runLinkCommand(process.cwd(), projectId, undefined, options);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program.parse();
