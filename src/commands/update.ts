import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm } from "@inquirer/prompts";
import { withSpinner } from "../utils/progress.js";

const PKG = "vasari-sync";

/** Version of the vsync installation this command is running from. */
export function runningVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

function npm(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      args,
      // npm is npm.cmd on Windows — needs a shell to resolve.
      { shell: process.platform === "win32", timeout: timeoutMs },
      (err, stdout) => {
        if (err) reject(new Error(err.message));
        else resolve(String(stdout));
      },
    );
  });
}

/**
 * `vsync update` — check npm for a newer vasari-sync and install it
 * globally. Confirm-first unless `--yes`; a registry outage is an
 * actionable error, never a silent no-op.
 */
export async function runUpdateCommand(yes = false): Promise<void> {
  const current = runningVersion();
  let latest: string;
  try {
    latest = (
      await withSpinner("Checking npm for updates", () => npm(["view", PKG, "version"], 20_000))
    ).trim();
  } catch (err) {
    throw new Error(`could not reach the npm registry — ${(err as Error).message}`);
  }

  if (latest === current) {
    console.log(`vasari-sync ${current} — already up to date.`);
    return;
  }

  if (!yes) {
    const ok = await confirm({ message: `Update vasari-sync ${current} → ${latest}?` });
    if (!ok) {
      console.log(`Skipped — still on ${current}.`);
      return;
    }
  }

  await withSpinner("Updating vasari-sync", () => npm(["install", "-g", `${PKG}@latest`], 300_000));
  console.log(`Updated vasari-sync ${current} → ${latest}.`);
  console.log("(the running session keeps the old version; new runs pick up the new one)");
}
