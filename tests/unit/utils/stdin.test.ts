import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { expandDash, readStdinPaths } from "../../../src/utils/stdin.js";

describe("readStdinPaths", () => {
  it("splits into trimmed non-empty lines (CRLF-safe)", async () => {
    const stdin = new PassThrough();
    stdin.end(".env\r\n  config.local.json  \n\nsub/app.local.json\n");
    await expect(readStdinPaths(stdin)).resolves.toEqual([
      ".env",
      "config.local.json",
      "sub/app.local.json",
    ]);
  });

  it("empty stdin → empty list", async () => {
    const stdin = new PassThrough();
    stdin.end("");
    await expect(readStdinPaths(stdin)).resolves.toEqual([]);
  });

  it("refuses a TTY (nothing piped) instead of hanging on input", async () => {
    const tty = new PassThrough();
    Object.defineProperty(tty, "isTTY", { value: true });
    await expect(readStdinPaths(tty)).rejects.toThrow(/no input piped/);
  });
});

describe("expandDash", () => {
  it("no dash → values untouched", async () => {
    await expect(expandDash([".env", "secrets.pem"])).resolves.toEqual([".env", "secrets.pem"]);
  });

  it("dash → stdin lines spliced in place", async () => {
    const stdin = new PassThrough();
    stdin.end("a.json\nb.json\n");
    await expect(expandDash(["-"], stdin)).resolves.toEqual(["a.json", "b.json"]);
    const stdin2 = new PassThrough();
    stdin2.end("a.json\n");
    await expect(expandDash(["first.txt", "-", "last.txt"], stdin2)).resolves.toEqual([
      "first.txt",
      "a.json",
      "last.txt",
    ]);
  });
});
