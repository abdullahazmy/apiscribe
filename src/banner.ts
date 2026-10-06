import chalk from "chalk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accent, dim } from "./ui.js";

/** The apiscribe mark: an API doc page with a JSON brace. */
const LOGO = [
  "▗▛▀▀▀▀▀▀▀▜▖",
  "▐  {   }  ▌",
  "▐  ━━━━━  ▌",
  "▐  ━━━    ▌",
  "▝▙▄▄▄▄▄▄▄▟▘",
];

type Style = (s: string) => string;
type Segment = [text: string, style?: Style];
type Cell = Segment[];

const plain: Style = (s) => s;
const len = (s: string) => [...s].length;

/** Fit a cell to `width` columns: truncate with … or pad, optionally centered. */
function fit(cell: Cell, width: number, center = false): string {
  let room = width;
  const out: string[] = [];
  for (const [text, style = plain] of cell) {
    const chars = [...text];
    if (chars.length <= room) {
      out.push(style(text));
      room -= chars.length;
    } else {
      out.push(style(chars.slice(0, Math.max(0, room - 1)).join("") + "…"));
      room = 0;
      break;
    }
  }
  const used = width - room;
  const left = center ? Math.floor((width - used) / 2) : 0;
  return " ".repeat(left) + out.join("") + " ".repeat(width - used - left);
}

/** Shorten a path for display: ~ for home, and a leading … when too long. */
function shortPath(p: string, max: number) {
  const home = os.homedir();
  if (p === home || p.startsWith(home + path.sep)) p = "~" + p.slice(home.length);
  const chars = [...p];
  return chars.length <= max ? p : "…" + chars.slice(chars.length - max + 1).join("");
}

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "4 doc files · updated 2h ago", or a nudge to run /scan. */
function docsSummary(docsDir: string): Cell[] {
  const dist = path.join(docsDir, "dist");
  let count = 0;
  let newest = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (abs !== dist) walk(abs);
      } else if (e.name.toLowerCase().endsWith(".md")) {
        count++;
        try {
          newest = Math.max(newest, fs.statSync(abs).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(docsDir);
  if (count === 0) return [[["No docs yet — run ", dim], ["/scan", accent]]];
  return [[[`${count} doc file${count === 1 ? "" : "s"}`], [` · updated ${ago(newest)}`, dim]]];
}

export interface BannerInfo {
  version: string;
  model: string;
  effort: string;
  projectRoot: string;
  docsDir: string;
}

/** Render the welcome box, two columns on wide terminals and one on narrow. */
export function renderBanner(info: BannerInfo, columns: number): string[] {
  const width = Math.min(Math.max(columns, 40), 100);
  const b = accent;
  const title = ` apiscribe v${info.version} `;
  const top = b("╭───") + chalk.bold(title) + b("─".repeat(Math.max(0, width - 5 - len(title))) + "╮");
  const bottom = b("╰" + "─".repeat(width - 2) + "╯");
  const row = (inner: string) => b("│") + inner + b("│");

  const docsRel = path.relative(info.projectRoot, info.docsDir) || ".";
  const lw = width >= 76 ? 40 : width - 2; // left column (or the only column)
  const left: [Cell, boolean][] = [
    [[], true],
    [[["Welcome to apiscribe!", chalk.bold]], true],
    [[["API docs for frontend & mobile teams", dim]], true],
    [[], true],
    ...LOGO.map((l): [Cell, boolean] => [[[l, accent]], true]),
    [[], true],
    [[[info.model, dim], [" · effort ", dim], [info.effort, dim]], true],
    [[[shortPath(info.projectRoot, lw - 4), dim]], true],
  ];
  const right: Cell[] = [
    [],
    [["Tips for getting started", (s) => accent(chalk.bold(s))]],
    [["/scan    ", accent], ["document every endpoint"]],
    [["/image   ", accent], ["map a screen to its APIs"]],
    [["/export  ", accent], ["build md · html · pdf"]],
    [["/help    ", accent], ["all commands"]],
    [],
    [["Docs", (s) => accent(chalk.bold(s))], [`  ${docsRel}/`, dim]],
    ...docsSummary(info.docsDir),
  ];

  const inner = width - 2;
  const lines = [top];
  if (width >= 76) {
    const rw = inner - lw - 1;
    const n = Math.max(left.length, right.length);
    for (let i = 0; i < n; i++) {
      const [lc, center] = left[i] ?? [[], false];
      lines.push(row(" " + fit(lc, lw - 2, center) + " " + b("│") + fit([[" "], ...(right[i] ?? [])], rw)));
    }
  } else {
    for (const [lc] of left) lines.push(row(" " + fit(lc, inner - 2, true) + " "));
    for (const rc of right) lines.push(row(fit([["  "], ...rc], inner)));
  }
  lines.push(bottom);
  return lines;
}

export function printBanner(info: BannerInfo) {
  for (const l of renderBanner(info, process.stdout.columns ?? 80)) console.log(l);
  console.log();
}
