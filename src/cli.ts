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
  .description("Set up storage backend + credentials (interactive)")
  .option("--show", "print current config with secrets redacted")
  .option("--set-default <backend>", "set the default backend without prompts")
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
  .description("Set up this project: pick files to track and a storage backend (interactive)")
  .action(async () => {
    try {
      await runInitCommand(process.cwd());
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("add")
  .description("Track file(s) for syncing (manifest only — nothing is uploaded)")
  .argument("<path...>", "file path(s) inside the project")
  .action(async (paths: string[]) => {
    try {
      await runAddCommand(process.cwd(), paths);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("rm")
  .description("Stop tracking file(s) — local files are NOT deleted")
  .argument("<path...>", "tracked file path(s)")
  .action(async (paths: string[]) => {
    try {
      await runRmCommand(process.cwd(), paths);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Show sync status of tracked files (paths and statuses only)")
  .action(async () => {
    try {
      await runStatusCommand(process.cwd());
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("diff")
  .description("Show differences between local files and the backend copy")
  .option("--show-values", "include full content diffs (prints actual file values)")
  .action(async (options: { showValues?: boolean }) => {
    try {
      await runDiffCommand(process.cwd(), options.showValues === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("push")
  .description("Upload tracked files that changed since the last sync")
  .option("-f, --force", "overwrite remote-only changes (local version wins)")
  .action(async (options: { force?: boolean }) => {
    try {
      await runPushCommand(process.cwd(), options.force === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("pull")
  .description("Download tracked files that changed on the backend since the last sync")
  .option("-f, --force", "overwrite local-only changes (remote version wins)")
  .action(async (options: { force?: boolean }) => {
    try {
      await runPullCommand(process.cwd(), options.force === true);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .description("Show all known projects (from the global registry)")
  .action(async () => {
    try {
      await runListCommand();
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
  .action(async (projectId: string) => {
    try {
      await runLinkCommand(process.cwd(), projectId);
    } catch (err) {
      console.error(`[vsync] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program.parse();
