import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import type { Config } from "./config.js";
import { systemPrompt } from "./prompts.js";
import { describeCall, runTool, TOOLS } from "./tools.js";
import { Spinner, dim, errorLine, toolLine, toolResultLine } from "./ui.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  // Re-run a safety-classifier refusal on Anthropic's recommended fallback model.
  "server-side-fallback-2026-07-01",
  // Surface Claude's short progress notes between tool calls.
  "thinking-display-updates-2026-08-18",
];

// $ per million tokens: [input, output, cache read, cache write]
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
};

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const MAX_TOOL_ROUNDS = 200;

/**
 * A conversational agent with an append-only history. History is never
 * rewritten, which keeps the prompt cache warm and thinking blocks valid.
 */
export class Agent {
  private client = new Anthropic();
  private messages: MessageParam[] = [];
  private system: string;
  readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private abort: AbortController | null = null;

  constructor(private cfg: Config) {
    this.system = systemPrompt(cfg);
  }

  reset() {
    this.messages = [];
  }

  /** Interrupt the in-flight turn (ctrl+c). Returns true if something was running. */
  interrupt(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  get busy() {
    return this.abort !== null;
  }

  costUSD(): number | null {
    const p = PRICES[this.cfg.model];
    if (!p) return null;
    const u = this.usage;
    return (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1e6;
  }

  /** Send one user turn and run tools until Claude is done. */
  async send(content: string | ContentBlockParam[]): Promise<void> {
    this.messages.push({ role: "user", content });
    this.abort = new AbortController();
    const spinner = new Spinner();
    let jsonRetries = 0;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        spinner.start();
        let atLineStart = true;
        let inThinking = false;

        const stream = this.client.beta.messages.stream(
          {
            model: this.cfg.model,
            max_tokens: 64000,
            betas: BETAS,
            fallbacks: "default",
            thinking: { type: "adaptive", display: "updates" },
            output_config: { effort: this.cfg.effort },
            cache_control: { type: "ephemeral" },
            system: this.system,
            tools: TOOLS,
            messages: this.messages,
          },
          { signal: this.abort.signal },
        );

        stream.on("thinking", (delta) => {
          if (!delta) return;
          spinner.stop();
          if (!inThinking) {
            if (!atLineStart) process.stdout.write("\n");
            process.stdout.write(dim("∴ "));
            inThinking = true;
          }
          process.stdout.write(dim(delta));
          atLineStart = delta.endsWith("\n");
        });
        stream.on("text", (delta) => {
          spinner.stop();
          if (inThinking) {
            process.stdout.write("\n\n");
            inThinking = false;
          }
          process.stdout.write(delta);
          atLineStart = delta.endsWith("\n");
        });
        stream.on("contentBlock", (block) => {
          if (block.type === "thinking" && inThinking) {
            process.stdout.write("\n");
            inThinking = false;
            atLineStart = true;
          }
          if (block.type === "text" && !atLineStart) {
            process.stdout.write("\n");
            atLineStart = true;
          }
        });

        let message: Anthropic.Beta.BetaMessage;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          spinner.stop();
          // With eager input streaming, an unparseable tool input surfaces as a
          // plain AnthropicError (the SDK has no dedicated class for it).
          // Re-issue the turn a couple of times; rethrow everything else.
          if (!isToolJsonError(err) || this.abort.signal.aborted || jsonRetries++ >= 2) throw err;
          console.error(dim("\n(tool input was not valid JSON — retrying the turn)"));
          continue;
        }
        spinner.stop();
        if (!atLineStart) process.stdout.write("\n");
        this.track(message.usage);

        if (message.stop_reason === "refusal") {
          // Discard the partial response; the history stays a valid prefix.
          errorLine(
            `Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}. Try rephrasing it.`,
          );
          return;
        }

        const toolUses = message.content.filter(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
        );

        if (message.stop_reason === "max_tokens") {
          if (toolUses.length === 0) {
            this.messages.push({ role: "assistant", content: message.content });
            errorLine("Response hit the output limit. Ask Claude to continue.");
          } else {
            // A tool input cut off at max_tokens may parse as a partial object; never run it.
            this.messages.push({ role: "assistant", content: message.content });
            this.messages.push({
              role: "user",
              content: toolUses.map((t) => ({
                type: "tool_result" as const,
                tool_use_id: t.id,
                is_error: true,
                content: "Output limit reached before this tool input was complete; it was not executed. Split the work into smaller files and retry.",
              })),
            });
            continue;
          }
          return;
        }

        this.messages.push({ role: "assistant", content: message.content });
        if (message.stop_reason === "pause_turn") continue;
        if (toolUses.length === 0) return;

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const t of toolUses) {
          toolLine(prettyToolName(t.name), describeCall(t.name, t.input));
          const out = await runTool(this.cfg, t.name, t.input);
          toolResultLine(out.summary, out.isError);
          results.push({ type: "tool_result", tool_use_id: t.id, content: out.content, is_error: out.isError || undefined });
        }
        this.messages.push({ role: "user", content: results });
      }
      errorLine(`Stopped after ${MAX_TOOL_ROUNDS} tool rounds.`);
    } catch (err) {
      spinner.stop();
      if (err instanceof Anthropic.APIUserAbortError || this.abort?.signal.aborted) {
        console.log(chalk.yellow("\n⏹  Interrupted."));
        return;
      }
      throw err;
    } finally {
      spinner.stop();
      this.abort = null;
    }
  }

  private track(u: Anthropic.Beta.BetaUsage) {
    this.usage.input += u.input_tokens ?? 0;
    this.usage.output += u.output_tokens ?? 0;
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
}

function isToolJsonError(err: unknown) {
  return (
    err instanceof Anthropic.AnthropicError &&
    !(err instanceof Anthropic.APIError) &&
    err.message.startsWith("Unable to parse tool parameter JSON")
  );
}

function prettyToolName(name: string) {
  return { list_files: "List", read_file: "Read", search: "Search", write_doc: "Write" }[name] ?? name;
}

/** Turn API errors into one readable line. */
export function explainError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Not authenticated. Set ANTHROPIC_API_KEY or run `ant auth login`.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Permission denied: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Not found (check the model name): ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited — wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `Network error: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  if (err instanceof Anthropic.AnthropicError && /authentication method/i.test(err.message)) {
    return "No Anthropic credentials found. Set ANTHROPIC_API_KEY or run `ant auth login`.";
  }
  return err instanceof Error ? err.message : String(err);
}
