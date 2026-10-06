import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import hljs from "highlight.js";
import { Marked, type Tokens } from "marked";
import { markedHighlight } from "marked-highlight";
import type { Config } from "./config.js";

export type ExportFormat = "md" | "html" | "pdf";
export const ALL_FORMATS: ExportFormat[] = ["md", "html", "pdf"];

interface DocFile {
  /** Path relative to the docs dir, posix separators. */
  rel: string;
  anchor: string;
  title: string;
  body: string;
}

const METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|WS|SSE)\s+(\S.*)$/;

/** Collect docs in reading order: README, endpoints, screens, everything else. */
async function collectDocs(cfg: Config): Promise<DocFile[]> {
  const distDir = path.join(cfg.docsDir, "dist");
  const files: string[] = [];
  async function walk(dir: string) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory() && abs !== distDir) await walk(abs);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) files.push(path.relative(cfg.docsDir, abs).split(path.sep).join("/"));
    }
  }
  if (!existsSync(cfg.docsDir)) return [];
  await walk(cfg.docsDir);

  const rank = (f: string) =>
    f.toLowerCase() === "readme.md" ? 0 : f.startsWith("endpoints/") ? 1 : f.startsWith("screens/") ? 2 : 3;
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  return Promise.all(
    files.map(async (rel) => {
      const body = await fs.readFile(path.join(cfg.docsDir, rel), "utf8");
      const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
      return { rel, anchor: fileAnchor(rel), title: h1 ?? titleFromPath(rel), body };
    }),
  );
}

function fileAnchor(rel: string) {
  return "doc-" + rel.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function titleFromPath(rel: string) {
  const base = path.posix.basename(rel, ".md").replace(/[-_]+/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** GitHub-compatible heading slug, so links Claude writes (#post-apiorders) resolve. */
function slugify(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Rewrite cross-file links (endpoints/orders.md#x) into in-page anchors (#x). */
function rewriteLinks(doc: DocFile, known: Set<string>): string {
  return doc.body.replace(/\]\(([^)\s]+?\.md)(#[^)\s]*)?\)/gi, (whole, target: string, frag?: string) => {
    if (/^[a-z]+:\/\//i.test(target)) return whole;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(doc.rel), target));
    if (!known.has(resolved)) return whole;
    return `](${frag ?? "#" + fileAnchor(resolved)})`;
  });
}

function projectName(cfg: Config) {
  for (const [file, re] of [
    ["package.json", /"name"\s*:\s*"([^"]+)"/],
    ["pyproject.toml", /^name\s*=\s*"([^"]+)"/m],
    ["composer.json", /"name"\s*:\s*"([^"]+)"/],
  ] as const) {
    const p = path.join(cfg.projectRoot, file);
    const m = existsSync(p) ? readFileSync(p, "utf8").match(re) : null;
    if (m) return m[1];
  }
  return path.basename(cfg.projectRoot);
}

export interface ExportResult {
  files: string[];
  warnings: string[];
}

export async function exportDocs(cfg: Config, formats: ExportFormat[]): Promise<ExportResult> {
  const docs = await collectDocs(cfg);
  if (docs.length === 0) {
    throw new Error(`No Markdown docs found in ${cfg.docsDir}. Run /scan first.`);
  }
  const outDir = path.join(cfg.docsDir, "dist");
  await fs.mkdir(outDir, { recursive: true });

  const known = new Set(docs.map((d) => d.rel));
  const name = projectName(cfg);
  const generated = new Date().toISOString().slice(0, 10);
  const result: ExportResult = { files: [], warnings: [] };

  if (formats.includes("md")) {
    const toc = docs.map((d) => `- [${d.title}](#${d.anchor})`).join("\n");
    const parts = docs.map((d) => `<a id="${d.anchor}"></a>\n\n${rewriteLinks(d, known).trim()}\n`);
    const md = `# ${name} — API Documentation\n\n_Generated ${generated} by apiscribe._\n\n## Contents\n\n${toc}\n\n---\n\n${parts.join("\n---\n\n")}`;
    const out = path.join(outDir, "API_DOCUMENTATION.md");
    await fs.writeFile(out, md);
    result.files.push(out);
  }

  if (formats.includes("html") || formats.includes("pdf")) {
    const html = renderHtml(docs, known, name, generated);
    const htmlOut = path.join(outDir, "API_DOCUMENTATION.html");
    if (formats.includes("html")) {
      await fs.writeFile(htmlOut, html);
      result.files.push(htmlOut);
    }
    if (formats.includes("pdf")) {
      const pdfOut = path.join(outDir, "API_DOCUMENTATION.pdf");
      try {
        await renderPdf(html, pdfOut, name);
        result.files.push(pdfOut);
      } catch (err) {
        result.warnings.push(`PDF skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}

interface NavItem {
  id: string;
  label: string;
  method?: string;
}

function renderHtml(docs: DocFile[], known: Set<string>, name: string, generated: string): string {
  const used = new Map<string, number>();
  const uniqueId = (base: string) => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  let nav: NavItem[] = [];
  const marked = new Marked(
    markedHighlight({
      emptyLangClass: "hljs",
      langPrefix: "hljs language-",
      highlight(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : "plaintext";
        return hljs.highlight(code, { language }).value;
      },
    }),
    {
      gfm: true,
      renderer: {
        heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth, text }: Tokens.Heading) {
          const plain = text.replace(/`/g, "").trim();
          const id = uniqueId(slugify(plain));
          const m = plain.match(METHODS);
          let inner = this.parser.parseInline(tokens);
          if (m) {
            const method = m[1].toUpperCase();
            inner = `<span class="method m-${method.toLowerCase()}">${method}</span><code class="route">${escapeHtml(m[2])}</code>`;
            if (depth <= 2) nav.push({ id, label: m[2], method });
          } else if (depth === 2) {
            nav.push({ id, label: plain });
          }
          const status = depth >= 3 && plain.match(/^([1-5])\d\d\b/);
          if (status) inner = `<span class="status s${status[1]}xx">${inner}</span>`;
          return `<h${depth} id="${id}"><a class="anchor" href="#${id}">#</a>${inner}</h${depth}>\n`;
        },
      },
    },
  );

  const sections: string[] = [];
  const navGroups: string[] = [];
  for (const d of docs) {
    nav = [];
    const body = (marked.parse(rewriteLinks(d, known), { async: false }) as string)
      // Wrap tables so wide ones scroll instead of breaking the layout.
      .replace(/<table>/g, '<div class="table-wrap"><table>')
      .replace(/<\/table>/g, "</table></div>");
    sections.push(`<section class="doc" id="${d.anchor}" data-file="${escapeHtml(d.rel)}">\n${body}\n</section>`);
    const items = nav
      .map(
        (n) =>
          `<li><a href="#${n.id}">${n.method ? `<span class="method m-${n.method.toLowerCase()}">${n.method}</span>` : ""}<span class="label">${escapeHtml(n.label)}</span></a></li>`,
      )
      .join("");
    navGroups.push(
      `<div class="nav-group"><a class="nav-title" href="#${d.anchor}">${escapeHtml(d.title)}</a>${items ? `<ul>${items}</ul>` : ""}</div>`,
    );
  }

  const title = `${escapeHtml(name)} — API Documentation`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<button class="menu" aria-label="Toggle navigation" onclick="document.body.classList.toggle('nav-open')">☰</button>
<aside class="sidebar">
  <div class="brand"><div class="brand-name">${escapeHtml(name)}</div><div class="brand-sub">API Documentation</div></div>
  <input class="filter" type="search" placeholder="Filter endpoints…" aria-label="Filter endpoints">
  <nav>${navGroups.join("\n")}</nav>
</aside>
<main>
  <header class="cover">
    <div class="eyebrow">API Reference</div>
    <h1 class="cover-title">${escapeHtml(name)}</h1>
    <p class="cover-sub">Integration guide for frontend and mobile developers · generated ${generated}</p>
  </header>
  ${sections.join("\n")}
  <footer>Generated by apiscribe · ${generated}</footer>
</main>
<script>${JS}</script>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CHROME_CANDIDATES = [
  process.env.APISCRIBE_CHROME,
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findChrome(): string {
  for (const c of CHROME_CANDIDATES) if (c && existsSync(c)) return c;
  throw new Error("no Chrome/Chromium/Edge found. Install one or set APISCRIBE_CHROME=/path/to/chrome");
}

async function renderPdf(html: string, out: string, name: string) {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: out,
      format: "A4",
      printBackground: true,
      margin: { top: "18mm", bottom: "18mm", left: "14mm", right: "14mm" },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:8px;color:#888;width:100%;padding:0 14mm;font-family:sans-serif">${escapeHtml(name)} · API Documentation</div>`,
      footerTemplate: `<div style="font-size:8px;color:#888;width:100%;padding:0 14mm;text-align:right;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
    });
  } finally {
    await browser.close();
  }
}

const CSS = `
:root{--bg:#fbfaf8;--panel:#ffffff;--side:#f3f1ec;--text:#1f1e1c;--muted:#6b6862;--border:#e4e0d8;--accent:#c96442;--code-bg:#f6f4ef;
--get:#1f7a4d;--post:#2457c5;--put:#9a6200;--patch:#7a4fc4;--delete:#c0392b;--other:#555;
--tk-key:#b5482a;--tk-str:#2f7d4f;--tk-num:#2457c5;--tk-com:#8a867e;--tk-fn:#7a4fc4;}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a18;--panel:#22211f;--side:#171614;--text:#ecebe7;--muted:#a19d95;--border:#34322e;--accent:#e08a68;--code-bg:#2a2926;
--get:#4cc38a;--post:#6e9bff;--put:#f0b54a;--patch:#b993ff;--delete:#ff7a6b;--other:#aaa;
--tk-key:#ff9e7a;--tk-str:#8fd6a8;--tk-num:#8db4ff;--tk-com:#7d796f;--tk-fn:#c9a8ff;}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;display:grid;grid-template-columns:290px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow:auto;background:var(--side);border-right:1px solid var(--border);padding:20px 14px}
.brand{padding:4px 8px 14px}.brand-name{font-weight:700;font-size:17px}.brand-sub{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.filter{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text);font:inherit;font-size:13px;margin-bottom:12px}
.nav-group{margin-bottom:10px}.nav-title{display:block;font-weight:600;font-size:13px;color:var(--text);text-decoration:none;padding:5px 8px;border-radius:6px}
.nav-group ul{list-style:none;margin:2px 0 0;padding:0}
.nav-group li a{display:flex;gap:8px;align-items:center;padding:4px 8px 4px 14px;border-radius:6px;color:var(--muted);text-decoration:none;font-size:13px}
.nav-group li a .label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.nav-group a:hover,.nav-group a.active{background:var(--panel);color:var(--text)}
main{padding:40px clamp(16px,5vw,64px) 80px;max-width:1080px;width:100%}
.cover{padding:24px 0 32px;border-bottom:1px solid var(--border);margin-bottom:8px}
.eyebrow{color:var(--accent);font-weight:600;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
.cover-title{font-size:38px;line-height:1.15;margin:8px 0}.cover-sub{color:var(--muted);margin:0}
.doc{padding-top:24px;border-bottom:1px solid var(--border);padding-bottom:24px}
h1,h2,h3,h4{position:relative;line-height:1.3}
h1{font-size:30px;margin:28px 0 12px}
h2{font-size:22px;margin:40px 0 10px;padding-top:12px;border-top:1px dashed var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h3{font-size:17px;margin:26px 0 8px}h4{font-size:15px;margin:20px 0 6px}
.anchor{position:absolute;left:-20px;opacity:0;color:var(--muted);text-decoration:none;font-weight:400}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor{opacity:1}
.method{display:inline-block;min-width:54px;text-align:center;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:5px 7px;border-radius:5px;color:#fff;background:var(--other);letter-spacing:.04em}
.nav-group .method{min-width:46px;font-size:10px;padding:3px 5px}
.m-get{background:var(--get)}.m-post{background:var(--post)}.m-put{background:var(--put)}.m-patch{background:var(--patch)}.m-delete{background:var(--delete)}
.route{font-size:18px;background:none;padding:0;word-break:break-all}
.status{display:inline-flex;align-items:center;gap:6px}
.status::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--other)}
.s2xx::before{background:var(--get)}.s3xx::before{background:var(--post)}.s4xx::before{background:var(--put)}.s5xx::before{background:var(--delete)}
a{color:var(--accent)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;background:var(--code-bg);padding:.12em .35em;border-radius:4px}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow:auto;font-size:13px;line-height:1.55}
pre code{background:none;padding:0;font-size:inherit}
.table-wrap{overflow-x:auto;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--side);font-weight:600}
tr:nth-child(even) td{background:color-mix(in srgb,var(--side) 40%,transparent)}
blockquote{margin:14px 0;padding:8px 14px;border-left:3px solid var(--accent);background:var(--panel);color:var(--muted);border-radius:0 8px 8px 0}
hr{border:none;border-top:1px solid var(--border);margin:28px 0}
footer{color:var(--muted);font-size:12px;margin-top:40px}
.hljs-keyword,.hljs-attr,.hljs-selector-tag,.hljs-meta{color:var(--tk-key)}
.hljs-string,.hljs-regexp,.hljs-addition{color:var(--tk-str)}
.hljs-number,.hljs-literal,.hljs-built_in,.hljs-type{color:var(--tk-num)}
.hljs-comment,.hljs-quote{color:var(--tk-com);font-style:italic}
.hljs-title,.hljs-function,.hljs-section{color:var(--tk-fn)}
.hljs-deletion{color:var(--delete)}
.menu{display:none}
@media (max-width:900px){body{grid-template-columns:1fr}.sidebar{position:fixed;inset:0 25% 0 0;z-index:10;transform:translateX(-105%);transition:transform .2s;box-shadow:0 0 40px rgba(0,0,0,.25)}
body.nav-open .sidebar{transform:none}.menu{display:block;position:fixed;top:12px;right:12px;z-index:11;border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:8px;padding:6px 10px;font-size:18px}
.anchor{display:none}}
@media print{body{display:block;background:#fff;color:#111;font-size:11.5px}.sidebar,.menu,.anchor,.filter{display:none!important}
main{padding:0;max-width:none}.cover{min-height:85vh;display:flex;flex-direction:column;justify-content:center;border:none;page-break-after:always}
.cover-title{font-size:44px}.doc{page-break-before:always;border:none}
pre,table,blockquote{page-break-inside:avoid}h2,h3{page-break-after:avoid}
pre{white-space:pre-wrap;word-break:break-word;font-size:10px}a{color:inherit;text-decoration:none}}
`;

const JS = `
(function(){
  var input=document.querySelector('.filter');
  input&&input.addEventListener('input',function(){
    var q=input.value.toLowerCase().trim();
    document.querySelectorAll('.nav-group').forEach(function(g){
      var any=false;
      g.querySelectorAll('li').forEach(function(li){var hit=!q||li.textContent.toLowerCase().indexOf(q)>-1;li.style.display=hit?'':'none';any=any||hit;});
      var titleHit=!q||g.querySelector('.nav-title').textContent.toLowerCase().indexOf(q)>-1;
      g.style.display=(any||titleHit)?'':'none';
    });
  });
  document.querySelectorAll('.sidebar a').forEach(function(a){a.addEventListener('click',function(){document.body.classList.remove('nav-open')})});
  var links={};document.querySelectorAll('.nav-group li a').forEach(function(a){links[a.getAttribute('href').slice(1)]=a});
  if('IntersectionObserver' in window){
    var obs=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting&&links[e.target.id]){
      document.querySelectorAll('.nav-group a.active').forEach(function(x){x.classList.remove('active')});links[e.target.id].classList.add('active');}})},{rootMargin:'0px 0px -75% 0px'});
    Object.keys(links).forEach(function(id){var el=document.getElementById(id);el&&obs.observe(el)});
  }
})();
`;
