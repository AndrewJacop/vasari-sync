#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runConfigCommand } from "./commands/config.js";

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

program.parse();
