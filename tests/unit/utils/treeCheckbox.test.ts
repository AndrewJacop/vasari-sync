import { describe, expect, it } from "vitest";
import type { Candidate } from "../../../src/core/candidateScanner.js";
import {
  buildTree,
  folderCheckState,
  subtreeFilePaths,
  visibleRows,
} from "../../../src/utils/treeCheckbox.js";

/** Minimal candidate helper — only what the tree uses. */
function cand(
  path: string,
  classification: Candidate["classification"],
  nestedRepo?: string,
): Candidate {
  return { path, size: 10, classification, rule: "", ...(nestedRepo ? { nestedRepo } : {}) };
}

function byPath(candidates: Candidate[]): Map<string, Candidate> {
  return new Map(candidates.map((c) => [c.path, c]));
}

describe("buildTree", () => {
  const candidates = [
    cand("optolink-backend/.env", "boosted", "optolink-backend"),
    cand("optolink-backend/CLAUDE.md", "shown", "optolink-backend"),
    cand("optolink-portal/.env", "boosted", "optolink-portal"),
    cand("CLAUDE.md", "shown"),
  ];
  const tree = buildTree(candidates);

  it("creates folder nodes for every directory segment, folders sorted before files", () => {
    expect(tree.children.map((n) => n.name)).toEqual([
      "optolink-backend",
      "optolink-portal",
      "CLAUDE.md",
    ]);
  });

  it("tags only folders that are nested-repo roots", () => {
    const backend = tree.children.find((n) => n.name === "optolink-backend");
    expect(backend?.repoFolder).toBe(true);
    expect(tree.children.find((n) => n.name === "CLAUDE.md")?.repoFolder).toBe(false);
    // Deeper folders are never repo roots themselves.
    expect(backend?.children.every((c) => c.repoFolder === false)).toBe(true);
  });
});

describe("visibleRows", () => {
  const candidates = [
    cand("optolink-backend/.env", "boosted", "optolink-backend"),
    cand("optolink-backend/deep/settings.local.json", "shown", "optolink-backend"),
    cand("local-notes.txt", "shown"),
  ];

  it("shows nested rows when expanded, hides them when collapsed", () => {
    const tree = buildTree(candidates);
    const expanded = visibleRows(tree, new Set());
    expect(expanded.map((r) => r.node.path)).toEqual([
      "optolink-backend",
      "optolink-backend/deep",
      "optolink-backend/deep/settings.local.json",
      "optolink-backend/.env",
      "local-notes.txt",
    ]);
    const collapsed = visibleRows(tree, new Set(["optolink-backend"]));
    expect(collapsed.map((r) => r.node.path)).toEqual(["optolink-backend", "local-notes.txt"]);
  });

  it("tracks depth per row", () => {
    const rows = visibleRows(buildTree(candidates), new Set());
    expect(
      rows.find((r) => r.node.path === "optolink-backend/deep/settings.local.json")?.depth,
    ).toBe(2);
  });
});

describe("selection model", () => {
  const candidates = [
    cand("repo/.env", "boosted", "repo"),
    cand("repo/CLAUDE.md", "shown", "repo"),
    cand("repo/inner/notes.txt", "shown", "repo"),
  ];
  const tree = buildTree(candidates);
  const map = byPath(candidates);

  it("subtreeFilePaths lists every file path below a node", () => {
    expect(subtreeFilePaths(tree).sort()).toEqual([...map.keys()].sort());
    const repoNode = tree.children[0];
    expect(subtreeFilePaths(repoNode).sort()).toEqual([
      "repo/.env",
      "repo/CLAUDE.md",
      "repo/inner/notes.txt",
    ]);
  });

  it("folderCheckState derives none/some/all from the selection", () => {
    const repoNode = tree.children[0];
    expect(folderCheckState(repoNode, new Set())).toBe("none");
    expect(folderCheckState(repoNode, new Set(["repo/.env"]))).toBe("some");
    expect(
      folderCheckState(repoNode, new Set(["repo/.env", "repo/CLAUDE.md", "repo/inner/notes.txt"])),
    ).toBe("all");
  });
});
