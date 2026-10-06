#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Agent, explainError } from "./agent.js";
import { resolveConfig, EFFORTS, type Config, type Effort } from "./config.js";
import { ALL_FORMATS, exportDocs, type ExportFormat } from "./export.js";
import { isImagePath, loadClipboardImage, loadImageFile, parsePathArgs, type LoadedImage } from "./image.js";
import { endpointPrompt, imagePrompt, scanPrompt } from "./prompts.js";
import { accent, banner, dim, errorLine, okLine } from "./ui.js";

const VERSION = "0.1.0";

const SLASH_COMMANDS: [string, string][] = [
  ["/scan [focus]", "Scan the backend and write/refresh docs for every endpoint"],
  ["/endpoint <what>", "Document or update a single endpoint, e.g. /endpoint POST /api/orders"],
  ["/image [paths…] [-- note]", "Map app screen(s) to the APIs to call. No path = paste from clipboard"],
  ["/export [md|html|pdf|all]", "Build API_DOCUMENTATION.{md,html,pdf} in <docs>/dist"],
  ["/docs", "List the documentation files"],
  ["/effort [level]", `Show or set reasoning effort (${EFFORTS.join(", ")})`],
  ["/cost", "Show token usage and estimated cost for this session"],
  ["/clear", "Start a fresh conversation (docs on disk are kept)"],
  ["/help", "Show this help"],
  ["/exit", "Quit"],
];

function printHelp() {
  console.log(chalk.bold("\nCommands"));
  for (const [cmd, desc] of SLASH_COMMANDS) console.log(`  ${accent(cmd.padEnd(28))} ${desc}`);
  console.log(chalk.bold("\nTips"));
  console.log(dim("  • Anything else you type is a chat message — ask questions or request changes to the docs."));
  console.log(dim("  • Drag an image file into the terminal (or paste its path) to map that screen."));
  console.log(dim("  • ctrl+c interrupts Claude; ctrl+c twice (or ctrl+d) exits.\n"));
}

function parseFormats(arg?: string): ExportFormat[] {
  if (!arg || arg === "all") return ALL_FORMATS;
  const fmts = arg.split(/[,\s]+/).filter(Boolean) as ExportFormat[];
  const bad = fmts.filter((f) => !ALL_FORMATS.includes(f));
  if (bad.length) throw new Error(`Unknown format(s): ${bad.join(", ")}. Use md, html, pdf or all.`);
  return fmts;
}

async function runExport(cfg: Config, formats: ExportFormat[]) {
  console.log(dim(`Exporting ${formats.join(", ")}…`));
  const res = await exportDocs(cfg, formats);
  for (const f of res.files) okLine(path.relative(process.cwd(), f) || f);
  for (const w of res.warnings) errorLine(w);
}

/** Split "/image a.png b.png -- this is the checkout page" into paths and a note. */
async function collectImages(args: string): Promise<{ images: LoadedImage[]; note?: string }> {
  const [pathPart, ...noteParts] = args.split(/\s--\s|^--\s/);
  const note = noteParts.join(" -- ").trim() || undefined;
  const paths = parsePathArgs(pathPart ?? "");
  if (paths.length === 0) return { images: [await loadClipboardImage()], note };
  return { images: await Promise.all(paths.map(loadImageFile)), note };
}

async function sendImages(agent: Agent, images: LoadedImage[], note?: string) {
  console.log(dim(`Attached ${images.map((i) => i.name).join(", ")}`));
  await agent.send([...images.map((i) => i.block), { type: "text", text: imagePrompt(images.map((i) => i.name), note) }]);
}

async function listDocs(cfg: Config) {
  if (!existsSync(cfg.docsDir)) return console.log(dim("No docs yet. Run /scan."));
  const out: string[] = [];
  async function walk(dir: string) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push(path.relative(cfg.docsDir, abs));
    }
  }
  await walk(cfg.docsDir);
  console.log(out.sort().map((f) => `  ${f}`).join("\n") || dim("(empty)"));
}

function printCost(agent: Agent) {
  const u = agent.usage;
  const cost = agent.costUSD();
  console.log(
    `${dim("input")} ${u.input.toLocaleString()}  ${dim("output")} ${u.output.toLocaleString()}  ${dim("cache read")} ${u.cacheRead.toLocaleString()}  ${dim("cache write")} ${u.cacheWrite.toLocaleString()}` +
      (cost !== null ? `  ${dim("≈")} ${chalk.bold("$" + cost.toFixed(4))}` : ""),
  );
}

async function handleLine(line: string, cfg: Config, agent: Agent): Promise<"exit" | void> {
  const input = line.trim();
  if (!input) return;

  // A bare dragged-in image path counts as /image.
  const asPaths = parsePathArgs(input);
  if (asPaths.length > 0 && asPaths.every((p) => isImagePath(p) && existsSync(p))) {
    const { images } = await collectImages(input);
    return sendImages(agent, images);
  }

  if (!input.startsWith("/")) return agent.send(input);

  const [cmd, ...rest] = input.split(/\s+/);
  const args = input.slice(cmd.length).trim();
  switch (cmd) {
    case "/exit":
    case "/quit":
      return "exit";
    case "/help":
      return printHelp();
    case "/clear":
      agent.reset();
      return okLine("Conversation cleared.");
    case "/cost":
      return printCost(agent);
    case "/docs":
      return listDocs(cfg);
    case "/effort":
      if (!args) return console.log(`effort: ${cfg.effort}`);
      if (!EFFORTS.includes(args as Effort)) return errorLine(`Use one of: ${EFFORTS.join(", ")}`);
      cfg.effort = args as Effort;
      return okLine(`effort set to ${args}`);
    case "/scan":
      return agent.send(scanPrompt(args || undefined));
    case "/endpoint":
      if (!args) return errorLine("Usage: /endpoint POST /api/orders");
      return agent.send(endpointPrompt(args));
    case "/image": {
      const { images, note } = await collectImages(args);
      return sendImages(agent, images, note);
    }
    case "/export":
      return runExport(cfg, parseFormats(rest.join(",")));
    default:
      return errorLine(`Unknown command ${cmd}. Type /help.`);
  }
}

async function repl(cfg: Config) {
  const agent = new Agent(cfg);
  banner(cfg.projectRoot, cfg.docsDir, cfg.model);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: accent("› "),
    historySize: 200,
    completer: (line: string) => {
      if (!line.startsWith("/") || line.includes(" ")) return [[], line];
      const names = SLASH_COMMANDS.map(([c]) => c.split(" ")[0]);
      const hits = names.filter((n) => n.startsWith(line));
      return [hits.length ? hits : names, line];
    },
  });

  let lastSigint = 0;
  rl.on("SIGINT", () => {
    if (agent.interrupt()) return;
    if (Date.now() - lastSigint < 1500) {
      rl.close();
      return;
    }
    lastSigint = Date.now();
    rl.write(null, { ctrl: true, name: "u" });
    console.log(dim("\n(press ctrl+c again to exit)"));
    rl.prompt();
  });

  // Handle lines one at a time; input typed while Claude works is queued.
  // Interactive close (ctrl+d / double ctrl+c) stops immediately; piped
  // input (`cat cmds.txt | apiscribe`) drains the queue first.
  const interactive = process.stdin.isTTY;
  let queue = Promise.resolve();
  let closed = false;
  rl.on("line", (line) => {
    queue = queue.then(async () => {
      if (closed && interactive) return;
      try {
        if ((await handleLine(line, cfg, agent)) === "exit") {
          rl.close();
          return;
        }
      } catch (err) {
        errorLine(explainError(err));
      }
      if (!closed) {
        console.log();
        rl.prompt();
      }
    });
  });
  rl.on("close", () => {
    closed = true;
    if (interactive) agent.interrupt();
    queue.finally(() => {
      printCost(agent);
      process.exit(0);
    });
  });
  rl.prompt();
}

async function oneShot(cfg: Config, fn: (agent: Agent) => Promise<void>) {
  const agent = new Agent(cfg);
  process.on("SIGINT", () => {
    if (!agent.interrupt()) process.exit(130);
  });
  try {
    await fn(agent);
  } catch (err) {
    errorLine(explainError(err));
    process.exitCode = 1;
  }
  printCost(agent);
}

const program = new Command()
  .name("apiscribe")
  .description("AI CLI built on Claude that writes API documentation for frontend & mobile developers")
  .version(VERSION)
  .option("-C, --project <dir>", "backend project root (default: current directory)")
  .option("-o, --docs-dir <dir>", "docs output directory, relative to the project (default: api-docs)")
  .option("-m, --model <model>", "Claude model (default: claude-opus-5-5, or $APISCRIBE_MODEL)")
  .option("-e, --effort <level>", `reasoning effort: ${EFFORTS.join(", ")} (default: high)`)
  .action(async () => repl(resolveConfig(program.opts())));

program
  .command("generate")
  .alias("scan")
  .description("scan the backend, write docs, then export md/html/pdf")
  .argument("[focus...]", "optional focus, e.g. \"only the payments module\"")
  .option("--no-export", "skip the md/html/pdf export step")
  .option("-f, --format <formats>", "export formats: md,html,pdf or all", "all")
  .action(async (focus: string[], opts: { export: boolean; format: string }) => {
    const cfg = resolveConfig(program.opts());
    await oneShot(cfg, async (agent) => {
      await agent.send(scanPrompt(focus.join(" ") || undefined));
      if (opts.export) await runExport(cfg, parseFormats(opts.format));
    });
  });

program
  .command("image")
  .description("map app screen image(s) to the APIs each screen should call")
  .argument("[images...]", "image files (omit to read from the clipboard)")
  .option("-n, --note <text>", "extra context, e.g. \"this is the checkout screen\"")
  .action(async (images: string[], opts: { note?: string }) => {
    const cfg = resolveConfig(program.opts());
    await oneShot(cfg, async (agent) => {
      const loaded = images.length ? await Promise.all(images.map(loadImageFile)) : [await loadClipboardImage()];
      await sendImages(agent, loaded, opts.note);
    });
  });

program
  .command("endpoint")
  .description("document or update a single endpoint")
  .argument("<what...>", "e.g. POST /api/orders")
  .action(async (what: string[]) => {
    const cfg = resolveConfig(program.opts());
    await oneShot(cfg, (agent) => agent.send(endpointPrompt(what.join(" "))));
  });

program
  .command("export")
  .description("render existing docs to API_DOCUMENTATION.{md,html,pdf} (no AI calls)")
  .option("-f, --format <formats>", "md,html,pdf or all", "all")
  .action(async (opts: { format: string }) => {
    try {
      await runExport(resolveConfig(program.opts()), parseFormats(opts.format));
    } catch (err) {
      errorLine(explainError(err));
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err) => {
  errorLine(explainError(err));
  process.exit(1);
});
