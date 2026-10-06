import chalk from "chalk";

export const accent = chalk.hex("#D97757");
export const dim = chalk.dim;

const FRAMES = ["✻", "✼", "✽", "✾", "✿", "❀", "✿", "✾", "✽", "✼"];

/** A one-line spinner on stderr that never interleaves with streamed text. */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private started = 0;

  start(label = "Thinking") {
    if (this.timer || !process.stderr.isTTY) return;
    this.started = Date.now();
    this.timer = setInterval(() => {
      const secs = Math.floor((Date.now() - this.started) / 1000);
      process.stderr.write(
        `\r${accent(FRAMES[this.frame++ % FRAMES.length])} ${accent(label + "…")} ${dim(`(${secs}s · ctrl+c to interrupt)`)}\x1b[K`,
      );
    }, 120);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    process.stderr.write("\r\x1b[K");
  }
}

export function toolLine(name: string, detail: string) {
  console.log(`${accent("●")} ${chalk.bold(name)}${dim("(")}${detail}${dim(")")}`);
}

export function toolResultLine(text: string, isError = false) {
  console.log(`  ${dim("⎿")}  ${isError ? chalk.red(text) : dim(text)}`);
}

export function errorLine(text: string) {
  console.error(chalk.red(`✗ ${text}`));
}

export function okLine(text: string) {
  console.log(`${chalk.green("✓")} ${text}`);
}
