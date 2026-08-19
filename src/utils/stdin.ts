/**
 * Stdin file lists (`-`) for commands that take many paths.
 *
 * A 100+ path list overflows the OS command-line length caps (cmd.exe caps
 * the whole line at ~8k chars, CreateProcess at ~32k, Linux argv at ~2MB),
 * so `vsync add -`, `vsync rm -`, and `vsync init --files -` read
 * newline-separated paths from stdin instead — any count streams fine.
 */

/** Reads the stream to a string and splits it into trimmed, non-empty lines (CRLF-safe). */
export async function readStdinPaths(
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string[]> {
  if ((stdin as NodeJS.ReadStream).isTTY) {
    throw new Error(
      "no input piped — pipe a newline-separated path list (e.g. `vsync add - < paths.txt`)",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Expands every `-` value into the stdin path list; other values pass through. */
export async function expandDash(
  values: string[],
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string[]> {
  if (!values.includes("-")) return values;
  const lines = await readStdinPaths(stdin);
  return values.flatMap((v) => (v === "-" ? lines : [v]));
}
