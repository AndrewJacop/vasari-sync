import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isUpKey,
  useKeypress,
  usePagination,
  usePrefix,
  useState,
  type Status,
} from "@inquirer/core";
import { styleText } from "node:util";
import type { Candidate } from "../core/candidateScanner.js";

/**
 * Tree-mode checkbox prompt for `vsync init`: candidates rendered as a
 * collapsible folder tree so whole directories can be selected/dropped
 * with one space. Folders show `[ ]` none / `[~]` some / `[x]` all;
 * toggling a folder selects everything under it (or clears it when full).
 * Nested-repo folders (see candidateScanner) are tagged so sub-repo files
 * are visibly folded under the umbrella project.
 *
 * Tree/selection logic lives in exported pure functions — the prompt shell
 * stays thin and the logic is unit-testable without a TTY.
 */

export interface TreeNode {
  name: string;
  /** Project-root-relative posix path ("" for the root sentinel). */
  path: string;
  /** Child folders first (alphabetical), then files (alphabetical). */
  children: TreeNode[];
  /** Present only on file nodes. */
  file?: Candidate;
  /** Folder is the root of a nested git repo. */
  repoFolder: boolean;
}

export interface VisibleRow {
  node: TreeNode;
  depth: number;
}

/** Builds the candidate tree. Folders-first sort; repo folders tagged. */
export function buildTree(candidates: Candidate[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], repoFolder: false };
  const repoRoots = new Set(
    candidates.flatMap((c) => (c.nestedRepo ? [c.nestedRepo] : [])),
  );

  for (const c of candidates) {
    const segments = c.path.split("/");
    let node = root;
    for (const seg of segments.slice(0, -1)) {
      let child = node.children.find((n) => n.name === seg && !n.file);
      if (!child) {
        child = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, children: [], repoFolder: false };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({
      name: segments.at(-1) ?? c.path,
      path: c.path,
      children: [],
      file: c,
      repoFolder: false,
    });
  }

  const sortAndTag = (node: TreeNode): void => {
    node.children.sort((a, b) => {
      const aFolder = !a.file;
      const bFolder = !b.file;
      if (aFolder !== bFolder) return aFolder ? -1 : 1; // folders first
      return cmpName(a.name, b.name);
    });
    for (const child of node.children) {
      child.repoFolder = !child.file && repoRoots.has(child.path);
      sortAndTag(child);
    }
  };
  sortAndTag(root);
  return root;
}

/** Every file path in a subtree. */
export function subtreeFilePaths(node: TreeNode): string[] {
  if (node.file) return [node.file.path];
  return node.children.flatMap((c) => subtreeFilePaths(c));
}

/** Folder checkbox state derived from which of its files are selected. */
export function folderCheckState(
  node: TreeNode,
  selected: ReadonlySet<string>,
): "all" | "some" | "none" {
  const paths = subtreeFilePaths(node);
  const count = paths.reduce((n, p) => n + (selected.has(p) ? 1 : 0), 0);
  if (count === 0) return "none";
  return count === paths.length ? "all" : "some";
}

/** Flattens the tree to the rows currently on screen (respecting folds). */
export function visibleRows(root: TreeNode, collapsed: ReadonlySet<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children) {
      rows.push({ node: child, depth });
      if (child.children.length > 0 && !collapsed.has(child.path)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

function allFolderPaths(node: TreeNode): string[] {
  if (node.file) return [];
  return node.children.flatMap((c) =>
    c.file ? [] : [c.path, ...allFolderPaths(c)],
  );
}

/** Code-unit ordering shared by folder/file sorts (locale-stable). */
function cmpName(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `[ ]` / `[~]` / `[x]` glyph for a folder's derived state. */
function folderGlyph(node: TreeNode, selected: ReadonlySet<string>): string {
  const state = folderCheckState(node, selected);
  if (state === "all") return styleText("green", "[x]");
  if (state === "some") return styleText("yellow", "[~]");
  return "[ ]";
}

function renderFolderRow(
  node: TreeNode,
  depth: number,
  isActive: boolean,
  collapsed: ReadonlySet<string>,
  selected: ReadonlySet<string>,
): string {
  const marker = isActive ? styleText("bold", "❯ ") : "  ";
  const indent = "│  ".repeat(depth);
  const glyph = collapsed.has(node.path) ? "▸" : "▾";
  const name = isActive ? styleText("bold", node.name) : node.name;
  const parts: string[] = [];
  if (node.repoFolder) parts.push(styleText("magenta", "nested repo"));
  if (collapsed.has(node.path))
    parts.push(styleText("dim", `· ${subtreeFilePaths(node).length} files`));
  const annotation = parts.length > 0 ? `   ${parts.join(" ")}` : "";
  return `${marker}${indent}${glyph} ${folderGlyph(node, selected)} ${name}${annotation}`;
}

function renderFileRow(node: TreeNode, depth: number, isActive: boolean, selected: ReadonlySet<string>): string {
  const file = node.file as Candidate; // guarded: only file nodes reach here
  const marker = isActive ? styleText("bold", "❯ ") : "  ";
  const indent = "│  ".repeat(depth);
  const box = selected.has(file.path) ? styleText("green", "[x]") : "[ ]";
  const name = isActive ? styleText("bold", node.name) : node.name;
  const size = styleText("dim", fmtSize(file.size));
  const suggested = file.classification === "boosted" ? `   ${styleText("cyan", "suggested")}` : "";
  return `${marker}${indent}  ${box} ${name}   ${size}${suggested}`;
}

export interface TreeCheckboxOptions {
  message: string;
  /** Non-suppressed candidates from scanCandidates. */
  candidates: Candidate[];
  pageSize?: number;
}

/** Resolves to the sorted list of selected file paths. */
export const treeCheckbox = createPrompt<string[], TreeCheckboxOptions>((config, done) => {
  const [status, setStatus] = useState<Status>("idle");
  const [active, setActive] = useState(0);
  // useState ignores the initial value after the first render, so these
  // allocations are one-time in effect.
  const [selected, setSelected] = useState<Set<string>>(
    new Set(config.candidates.filter((c) => c.classification === "boosted").map((c) => c.path)),
  );
  const tree = buildTree(config.candidates); // pure; rebuilt per render is fine
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(allFolderPaths(tree)));
  const rows = visibleRows(tree, collapsed);
  const prefix = usePrefix({ status });

  useKeypress((key) => {
    if (isEnterKey(key)) {
      setStatus("done");
      done([...selected].sort());
      return;
    }
    if (isUpKey(key) || isDownKey(key)) {
      if (rows.length === 0) return;
      const delta = isUpKey(key) ? -1 : 1;
      setActive((active + delta + rows.length) % rows.length);
      return;
    }

    const row = rows[active];
    if (!row) return;

    if (isSpaceKey(key)) {
      if (row.node.file) {
        const next = new Set(selected);
        if (next.has(row.node.file.path)) next.delete(row.node.file.path);
        else next.add(row.node.file.path);
        setSelected(next);
      } else {
        // Folder: select everything unless everything is already in.
        const fill = folderCheckState(row.node, selected) !== "all";
        const next = new Set(selected);
        for (const p of subtreeFilePaths(row.node)) {
          if (fill) next.add(p);
          else next.delete(p);
        }
        setSelected(next);
      }
      return;
    }
    if (key.name === "right" && !row.node.file) {
      const next = new Set(collapsed);
      next.delete(row.node.path);
      setCollapsed(next);
      return;
    }
    if (key.name === "left" && !row.node.file) {
      const next = new Set(collapsed);
      next.add(row.node.path);
      setCollapsed(next);
      return;
    }
    if (key.name === "a" && !key.ctrl) {
      setSelected(new Set(config.candidates.map((c) => c.path)));
      return;
    }
    if (key.name === "n" && !key.ctrl) {
      setSelected(new Set());
    }
  });

  const renderRow = (row: VisibleRow, isActive: boolean): string =>
    row.node.file
      ? renderFileRow(row.node, row.depth, isActive, selected)
      : renderFolderRow(row.node, row.depth, isActive, collapsed, selected);

  const page = usePagination({
    items: rows,
    active,
    renderItem: ({ item, isActive }) => renderRow(item, isActive),
    pageSize: config.pageSize ?? 15,
  });

  if (status === "done") {
    return `${prefix} ${config.message} · ${selected.size} selected`;
  }

  const help = styleText(
    "dim",
    "(↑/↓ move · space toggle file/folder · →/← fold · a all · n none · enter confirm)",
  );
  return [`${prefix} ${config.message} — ${selected.size} selected`, `${help}\n${page}`];
});
