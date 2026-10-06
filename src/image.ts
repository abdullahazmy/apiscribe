import type Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type MediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const EXT_TYPES: Record<string, MediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_BYTES = 5 * 1024 * 1024; // API limit per image

export interface LoadedImage {
  name: string;
  block: Anthropic.Beta.BetaImageBlockParam;
}

export function isImagePath(p: string): boolean {
  return path.extname(p).toLowerCase() in EXT_TYPES;
}

/**
 * Split what the user typed or pasted after /image into paths. Handles
 * terminal drag-and-drop forms: 'quoted paths', "double quoted",
 * backslash-escaped spaces, and file:// URLs.
 */
export function parsePathArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && process.platform !== "win32" && i + 1 < input.length) cur += input[++i];
    else if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out.map((p) => {
    if (p.startsWith("file://")) p = decodeURIComponent(new URL(p).pathname);
    if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
    return p;
  });
}

export async function loadImageFile(file: string): Promise<LoadedImage> {
  const abs = path.resolve(file);
  const mediaType = EXT_TYPES[path.extname(abs).toLowerCase()];
  if (!mediaType) throw new Error(`${file}: unsupported image type (use png, jpg, gif or webp)`);
  const data = await fs.readFile(abs).catch(() => {
    throw new Error(`${file}: file not found`);
  });
  return toImage(path.basename(abs), data, mediaType);
}

/** Read an image from the system clipboard (Wayland, X11, macOS, Windows). */
export async function loadClipboardImage(): Promise<LoadedImage> {
  const data = await readClipboard();
  if (!data || data.length === 0) {
    throw new Error("No image found on the clipboard. Copy a screenshot first, or pass a file path: /image ./screen.png");
  }
  return toImage("clipboard.png", data, "image/png");
}

function toImage(name: string, data: Buffer, mediaType: MediaType): LoadedImage {
  if (data.length > MAX_BYTES) {
    throw new Error(`${name} is ${(data.length / 1024 / 1024).toFixed(1)}MB; images must be under 5MB. Resize or crop it first.`);
  }
  return {
    name,
    block: { type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } },
  };
}

async function readClipboard(): Promise<Buffer | null> {
  const run = async (cmd: string, args: string[]) => {
    const { stdout } = await execFileAsync(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    return stdout as Buffer;
  };

  if (process.platform === "darwin") {
    try {
      return await run("pngpaste", ["-"]);
    } catch {
      const tmp = path.join(os.tmpdir(), `apiscribe-clip-${process.pid}.png`);
      await execFileAsync("osascript", [
        "-e",
        `set f to open for access POSIX file "${tmp}" with write permission`,
        "-e",
        "write (the clipboard as «class PNGf») to f",
        "-e",
        "close access f",
      ]).catch(() => null);
      const buf = await fs.readFile(tmp).catch(() => null);
      await fs.rm(tmp, { force: true });
      return buf;
    }
  }

  if (process.platform === "win32") {
    const tmp = path.join(os.tmpdir(), `apiscribe-clip-${process.pid}.png`);
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; $i=[System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${tmp}') }`,
    ]).catch(() => null);
    const buf = await fs.readFile(tmp).catch(() => null);
    await fs.rm(tmp, { force: true });
    return buf;
  }

  // Linux: Wayland first, then X11.
  if (process.env.WAYLAND_DISPLAY) {
    try {
      const { stdout } = await execFileAsync("wl-paste", ["--list-types"]);
      if (stdout.split("\n").includes("image/png")) return await run("wl-paste", ["--type", "image/png"]);
    } catch {
      /* fall through to X11 */
    }
  }
  try {
    return await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
  } catch {
    return null;
  }
}
