// Checks the links between the documentation pages in docs/: every relative link must point at a
// file inside docs/ (GitHub Pages serves nothing else), and every #anchor at a heading of that
// page. Jekyll doesn't fail a build on a broken link, so CI runs this first.
//
//   node tools/docs/check-links.mjs [docs-dir]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** A heading's anchor as GitHub and kramdown make it, for the headings these pages use. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** The anchors of a Markdown page's headings, outside fenced code. */
export function anchors(text) {
  const out = new Set();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (match?.[1] !== undefined) out.add(slug(match[1]));
  }
  return out;
}

/** Inline links in a page, outside fenced and inline code. */
export function links(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const prose = line.replace(/`[^`]*`/g, "");
    for (const match of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(match[1]);
  }
  return out;
}

/** Problems with the links in every page under `root`, as "page: problem" lines. */
export function check(root) {
  const pages = readdirSync(root).filter((name) => name.endsWith(".md"));
  const problems = [];
  for (const page of pages) {
    const path = join(root, page);
    const text = readFileSync(path, "utf8");
    for (const target of links(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
      const [file, anchor] = target.split("#");
      const resolved = file === "" ? path : resolve(dirname(path), file);
      const inside = relative(root, resolved);
      if (inside.startsWith("..")) {
        problems.push(`${page}: ${target} is outside docs/, which GitHub Pages doesn't publish`);
        continue;
      }
      if (!existsSync(resolved)) {
        problems.push(`${page}: ${target} doesn't exist`);
        continue;
      }
      if (anchor !== undefined && anchor !== "" && resolved.endsWith(".md")) {
        if (!anchors(readFileSync(resolved, "utf8")).has(anchor)) {
          problems.push(`${page}: ${target} has no heading for #${anchor}`);
        }
      }
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(process.argv[2] ?? "docs");
  const problems = check(root);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(`Links in ${root} are fine.`);
}
