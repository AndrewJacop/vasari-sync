import { render } from "@inquirer/testing";
import { describe, expect, it } from "vitest";
import type { Candidate } from "../../../src/core/candidateScanner.js";
import { treeCheckbox } from "../../../src/utils/treeCheckbox.js";

/** OPTOLINK-shaped fixture: two nested repos + a parent-level file. */
const candidates: Candidate[] = [
  { path: "optolink-backend/.env", size: 412, classification: "boosted", rule: "pattern:.env*", nestedRepo: "optolink-backend" },
  { path: "optolink-backend/CLAUDE.md", size: 2100, classification: "shown", rule: "" },
  { path: "optolink-portal/.env", size: 182, classification: "boosted", rule: "pattern:.env*", nestedRepo: "optolink-portal" },
  { path: "local-notes.txt", size: 40, classification: "shown", rule: "" },
];

/** Strips ANSI so assertions read as plain text. */
function clean(frame: string): string {
  return frame.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("treeCheckbox — prompt shell", () => {
  it("renders folders collapsed, boosted pre-checked, count in header", async () => {
    const { getScreen } = await render(treeCheckbox, { message: "Files to track", candidates });
    const screen = clean(getScreen());
    expect(screen).toContain("Files to track — 2 selected");
    expect(screen).toContain("▸ [~] optolink-backend");
    expect(screen).toContain("nested repo");
    expect(screen).toContain("2 files");
    expect(screen).toContain("▸ [x] optolink-portal");
    expect(screen).toContain("local-notes.txt");
  });

  it("→ expands a folder, space selects the whole subtree, enter confirms", async () => {
    const { getScreen, events, answer } = await render(treeCheckbox, {
      message: "Files to track",
      candidates,
    });
    // Cursor starts on the first row (optolink-backend folder, mixed state).
    events.keypress("right"); // expand
    expect(clean(getScreen())).toContain("▾ [~] optolink-backend");
    events.keypress("space"); // mixed → select all (already has .env)
    expect(clean(getScreen())).toContain("▾ [x] optolink-backend");
    events.keypress("down");
    events.keypress("space"); // .env off → folder drops to some
    expect(clean(getScreen())).toContain("▾ [~] optolink-backend");
    events.keypress("up");
    events.keypress("space"); // back to all
    events.keypress("enter");
    expect(await answer).toEqual([
      "optolink-backend/.env",
      "optolink-backend/CLAUDE.md",
      "optolink-portal/.env",
    ]);
  });

  it("← collapses; n clears; a selects everything", async () => {
    const { getScreen, events, answer } = await render(treeCheckbox, {
      message: "Files to track",
      candidates,
      pageSize: 20,
    });
    events.keypress("n");
    expect(clean(getScreen())).toContain("Files to track — 0 selected");
    events.keypress("a");
    expect(clean(getScreen())).toContain("Files to track — 4 selected");
    events.keypress("right"); // expand backend under cursor
    events.keypress("left"); // collapse again
    expect(clean(getScreen())).toContain("▸ [x] optolink-backend");
    events.keypress("enter");
    expect(await answer).toHaveLength(4);
  });

  it("done state renders the selected count", async () => {
    const { getScreen, events, answer } = await render(treeCheckbox, {
      message: "Files to track",
      candidates,
    });
    events.keypress("enter");
    await answer;
    expect(clean(getScreen())).toContain("Files to track · 2 selected");
  });
});
