import { styleText } from "node:util";

/**
 * Minimal transfer spinner for push/pull.
 *
 * TTY: animated braille frames on stderr (`\r` overwrite, one line).
 * Non-TTY (CI, piped output, tests): each `start`/`update`-with-new-message
 * prints one plain line instead — progress stays visible in logs without
 * control characters.
 *
 * ponytail: no per-byte progress bar — that would mean touching every
 * backend handler for a byte counter; a spinning frame already proves
 * liveness. Upgrade path: progress callback on StorageBackend if byte
 * granularity ever matters.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const INTERVAL_MS = 80;

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private message = "";
  private readonly isTty: boolean;

  constructor(isTty: boolean = process.stderr.isTTY === true) {
    this.isTty = isTty;
  }

  /** Shows `message`; a later `update` with the same text is a no-op. */
  private render(): void {
    process.stderr.write(`\r${styleText("cyan", FRAMES[this.frame])} ${this.message}`);
  }

  start(message: string): void {
    this.message = message;
    if (!this.isTty) {
      console.log(styleText("dim", `${message}…`));
      return;
    }
    if (this.timer) clearInterval(this.timer);
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, INTERVAL_MS);
  }

  update(message: string): void {
    if (message === this.message) return;
    this.start(message);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.isTty) process.stderr.write("\r\u001b[K"); // clear the line
  }
}

/** Runs `fn` under a spinner showing `message`. Always stops the spinner,
 * even when `fn` rejects — call sites stay one line each. */
export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const spinner = new Spinner();
  spinner.start(message);
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}
