import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { confine, type Config } from "./config.js";

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage", "vendor",
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "target", "bin", "obj",
  ".next", ".nuxt", ".idea", ".vscode", ".gradle", ".dart_tool", "storage", "tmp",
]);
const MAX_LIST = 1500;
const MAX_READ_LINES = 2000;
const MAX_LINE_LEN = 2000;
const MAX_MATCHES = 250;
const DOC_EXTENSIONS = new Set([".md", ".json", ".yaml", ".yml"]);

const ListFilesInput = z.object({
  path: z.string().optional(),
  glob: z.string().optional(),
  max_depth: z.number().int().min(1).max(30).optional(),
});
const ReadFileInput = z.object({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_READ_LINES).optional(),
});
const SearchInput = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignore_case: z.boolean().optional(),
});
const WriteDocInput = z.object({ path: z.string().min(1), content: z.string() });

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_files",
    description:
      "List files under a directory of the backend project (relative to the project root). Common build/vendor folders are skipped. Use `glob` (e.g. \"**/*.controller.ts\", \"routes/**\") to filter.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the project root. Defaults to the root." },
        glob: { type: "string", description: "Optional glob filter matched against the path relative to `path`." },
        max_depth: { type: "integer", description: "Maximum directory depth (default 12)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      `Read a text file from the backend project with line numbers. Returns at most ${MAX_READ_LINES} lines per call; use offset/limit for long files.`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        offset: { type: "integer", description: "1-based line to start from." },
        limit: { type: "integer", description: "Number of lines to read." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "Regex search across the backend project's files (ripgrep syntax). Returns file:line:match. Great for finding route registrations, decorators, DTOs, validators, middleware, and error handlers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Directory or file to search, relative to the project root." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. \"*.py\"." },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "write_doc",
    description:
      "Create or overwrite a documentation file inside the docs directory. `path` is relative to the docs directory (e.g. \"README.md\", \"endpoints/users.md\", \"screens/login.md\"). Only .md, .json, .yaml and .yml files are allowed. Write one complete file per call.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the docs directory." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Short human summary for the terminal. */
  summary: string;
}

/** One-line description of a tool call for the terminal. */
export function describeCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "list_files":
      return [i.path ?? ".", i.glob].filter(Boolean).join(", ");
    case "read_file":
      return String(i.path ?? "");
    case "search":
      return `"${i.pattern}"${i.path ? ` in ${i.path}` : ""}${i.glob ? ` (${i.glob})` : ""}`;
    case "write_doc":
      return String(i.path ?? "");
    default:
      return "";
  }
}

export async function runTool(cfg: Config, name: string, rawInput: unknown): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "list_files":
        return await listFiles(cfg, ListFilesInput.parse(rawInput));
      case "read_file":
        return await readFile(cfg, ReadFileInput.parse(rawInput));
      case "search":
        return await search(cfg, SearchInput.parse(rawInput));
      case "write_doc":
        return await writeDoc(cfg, WriteDocInput.parse(rawInput));
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(`Invalid input for ${name}: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Re-issue the call with complete, valid JSON.`);
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function fail(message: string): ToolOutcome {
  return { content: message, isError: true, summary: message };
}

function rel(cfg: Config, abs: string) {
  return path.relative(cfg.projectRoot, abs) || ".";
}

async function listFiles(cfg: Config, input: z.infer<typeof ListFilesInput>): Promise<ToolOutcome> {
  const base = confine(cfg.projectRoot, input.path ?? ".");
  const matcher = input.glob ? globToRegExp(input.glob) : null;
  const maxDepth = input.max_depth ?? 12;
  const out: string[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number) {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (abs === cfg.docsDir) continue;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue;
        if (depth < maxDepth) await walk(abs, depth + 1);
      } else if (e.isFile()) {
        const r = path.relative(base, abs).split(path.sep).join("/");
        if (matcher && !matcher.test(r) && !matcher.test(e.name)) continue;
        out.push(rel(cfg, abs));
        if (out.length >= MAX_LIST) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(base, 1);
  const note = truncated ? `\n… truncated at ${MAX_LIST} entries; narrow with path/glob.` : "";
  return {
    content: (out.join("\n") || "(no files)") + note,
    isError: false,
    summary: `${out.length}${truncated ? "+" : ""} files`,
  };
}

async function readFile(cfg: Config, input: z.infer<typeof ReadFileInput>): Promise<ToolOutcome> {
  const abs = confine(cfg.projectRoot, input.path);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) return fail(`${input.path} is not a file`);
  if (stat.size > 5 * 1024 * 1024) return fail(`${input.path} is larger than 5MB; use search instead`);
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return fail(`${input.path} looks like a binary file`);
  const lines = buf.toString("utf8").split("\n");
  const start = (input.offset ?? 1) - 1;
  const end = Math.min(lines.length, start + (input.limit ?? MAX_READ_LINES));
  const body = lines
    .slice(start, end)
    .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + "…" : l}`)
    .join("\n");
  const more = end < lines.length ? `\n… ${lines.length - end} more lines (continue with offset=${end + 1})` : "";
  return { content: body + more, isError: false, summary: `${end - start} lines` };
}

async function search(cfg: Config, input: z.infer<typeof SearchInput>): Promise<ToolOutcome> {
  const target = confine(cfg.projectRoot, input.path ?? ".");
  const args = ["-n", "--no-heading", "--color=never", "--max-columns=400", "--max-count=50"];
  if (input.ignore_case) args.push("-i");
  if (input.glob) args.push("-g", input.glob);
  for (const d of IGNORED_DIRS) args.push("-g", `!${d}/`);
  args.push("-g", `!${path.relative(cfg.projectRoot, cfg.docsDir)}/`);
  args.push("-e", input.pattern, path.relative(cfg.projectRoot, target) || ".");

  let lines: string[];
  try {
    const { stdout } = await execFileAsync("rg", args, { cwd: cfg.projectRoot, maxBuffer: 32 * 1024 * 1024 });
    lines = stdout.split("\n").filter(Boolean);
  } catch (err) {
    const e = err as { code?: string | number; message: string; stderr?: string };
    if (e.code === 1) lines = []; // rg: no matches
    else if (e.code === "ENOENT") lines = await jsSearch(cfg, target, input);
    else return fail(`search failed: ${e.stderr || e.message}`);
  }
  const total = lines.length;
  const shown = lines.slice(0, MAX_MATCHES);
  const note = total > MAX_MATCHES ? `\n… ${total - MAX_MATCHES} more matches; narrow the pattern or path.` : "";
  return { content: (shown.join("\n") || "(no matches)") + note, isError: false, summary: `${total} matches` };
}

/** Fallback when ripgrep is not installed. */
async function jsSearch(cfg: Config, target: string, input: z.infer<typeof SearchInput>): Promise<string[]> {
  const re = new RegExp(input.pattern, input.ignore_case ? "i" : "");
  const files = (await listFiles(cfg, { path: path.relative(cfg.projectRoot, target) || ".", glob: input.glob })).content
    .split("\n")
    .filter((f) => f && !f.startsWith("…"));
  const out: string[] = [];
  for (const f of files) {
    const abs = path.join(cfg.projectRoot, f);
    let text: string;
    try {
      const buf = await fs.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      if (re.test(line)) out.push(`${f}:${i + 1}:${line.slice(0, 400)}`);
    });
    if (out.length > MAX_MATCHES * 4) break;
  }
  return out;
}

async function writeDoc(cfg: Config, input: z.infer<typeof WriteDocInput>): Promise<ToolOutcome> {
  const abs = confine(cfg.docsDir, input.path);
  if (!DOC_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
    return fail(`Only ${[...DOC_EXTENSIONS].join(", ")} files can be written`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const existed = await fs.stat(abs).then(() => true, () => false);
  await fs.writeFile(abs, input.content.endsWith("\n") ? input.content : input.content + "\n");
  const lines = input.content.split("\n").length;
  return {
    content: `${existed ? "Updated" : "Created"} ${path.relative(cfg.docsDir, abs)} (${lines} lines)`,
    isError: false,
    summary: `${existed ? "updated" : "created"} · ${lines} lines`,
  };
}

/** Minimal glob → RegExp supporting **, *, ?, and {a,b}. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, close).split(",").map(escapeRe).join("|") + ")";
        i = close;
      }
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
