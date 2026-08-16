#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runAddCommand } from "./commands/add.js";
import { runConfigCommand } from "./commands/config.js";
import { runInitCommand } from "./commands/init.js";
import { runRmCommand } from "./commands/rm.js";

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

program.parse();
