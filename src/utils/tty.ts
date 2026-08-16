/**
 * TTY guards for non-interactive runs (AI agents, CI, VS Code extension).
 *
 * Every prompt site follows the same rule: flag → use it; no flag + TTY →
 * prompt (unchanged); no flag + no TTY → fail fast with the missing flag
 * named, instead of an inquirer prompt that hangs or dies cryptically.
 */

/** True when stdin cannot answer an interactive prompt. */
export function isNonInteractive(): boolean {
  return process.stdin.isTTY !== true;
}

/**
 * Called where an interactive prompt would gather *required information*
 * (not a yes/no safety confirm): throws when there's no TTY to answer it.
 * `flagHint` names the flag(s) that supply the value non-interactively.
 */
export function requireTty(flagHint: string): void {
  if (isNonInteractive()) {
    throw new Error(
      `Non-interactive session: pass ${flagHint} (or run from a terminal to answer the prompt).`,
    );
  }
}
