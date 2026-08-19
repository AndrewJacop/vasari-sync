#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { expandDash } from "./utils/stdin.js";

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
  .version(readVersion())
  // Config-file override: one file per user on a shared device. Subcommands
  // accept it in either position (commander v15 inherits parent options):
  // `vsync --config x push` or `vsync push --config x`. Funneled into the
  // VSYNC_CONFIG env var before any command runs — globalConfigPath() turns
  // it into the active config file for every read/write.
  .option(
    "--config <path>",
    "use this config file instead of ~/.vsync/config.json (multi-profile: one file per user)",
  )
  .hook("preAction", (thisCmd) => {
    const cfg = thisCmd.optsWithGlobals().config;
    if (cfg === undefined) return;
    if (typeof cfg !== "string" || !cfg.trim()) {
      program.error("--config requires a non-empty file path.");
    }
    process.env.VSYNC_CONFIG = resolve(cfg);
  });

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
    "non-interactive: project-relative file paths to track (repeatable, comma-split; `-` reads newline-separated paths from stdin)",
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
  .description(
    "Track file(s) for syncing (manifest only — nothing is uploaded); `-` reads paths from stdin",
  )
  .argument("<path...>", "file path(s) inside the project, or `-` for a stdin list")
  .option("--json", "machine-readable output")
  .action(async (paths: string[], options: { json?: boolean }) => {
    try {
      await runAddCommand(process.cwd(), await expandDash(paths), options.json === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("rm")
  .description("Stop tracking file(s) — local files are NOT deleted; `-` reads paths from stdin")
  .argument("<path...>", "tracked file path(s), or `-` for a stdin list")
  .option("--json", "machine-readable output")
  .action(async (paths: string[], options: { json?: boolean }) => {
    try {
      await runRmCommand(process.cwd(), await expandDash(paths), options.json === true);
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
  .description(
    "Upload tracked files that changed (local overwrites remote; missing local files are deleted remotely)",
  )
  .option("-y, --yes", "skip the confirmation prompt")
  .option("-f, --force", "legacy alias for --yes")
  .option("--json", "machine-readable output")
  .action(async (options: { yes?: boolean; force?: boolean; json?: boolean }) => {
    try {
      await runPushCommand(
        process.cwd(),
        options.yes === true || options.force === true,
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
  .description(
    "Download tracked files that changed (remote overwrites local; files missing locally are restored)",
  )
  .option("-y, --yes", "skip the confirmation prompt")
  .option("-f, --force", "legacy alias for --yes")
  .option("--json", "machine-readable output")
  .action(async (options: { yes?: boolean; force?: boolean; json?: boolean }) => {
    try {
      await runPullCommand(
        process.cwd(),
        options.yes === true || options.force === true,
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
