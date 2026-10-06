import path from "node:path";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Config {
  /** Root of the backend project being documented. All file reads are confined here. */
  projectRoot: string;
  /** Where generated Markdown lives. All writes are confined here. */
  docsDir: string;
  model: string;
  effort: Effort;
}

export const DEFAULT_MODEL = "claude-opus-5-5";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function resolveConfig(opts: {
  project?: string;
  docsDir?: string;
  model?: string;
  effort?: string;
}): Config {
  const projectRoot = path.resolve(opts.project ?? process.cwd());
  const docsDir = path.resolve(projectRoot, opts.docsDir ?? process.env.APISCRIBE_DOCS_DIR ?? "api-docs");
  const effort = (opts.effort ?? process.env.APISCRIBE_EFFORT ?? "high") as Effort;
  if (!EFFORTS.includes(effort)) {
    throw new Error(`Invalid effort "${effort}". Use one of: ${EFFORTS.join(", ")}`);
  }
  return {
    projectRoot,
    docsDir,
    model: opts.model ?? process.env.APISCRIBE_MODEL ?? DEFAULT_MODEL,
    effort,
  };
}

/** Resolve `p` against `root` and refuse anything that escapes it. */
export function confine(root: string, p: string): string {
  const target = path.resolve(root, p);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside ${root}`);
  }
  return target;
}
