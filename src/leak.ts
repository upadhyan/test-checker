import * as fs from "node:fs";
import * as path from "node:path";
import type { Repo } from "./repo";
import { matchGlobs, readJson, writeJson } from "./util";

/** engine-spec §6 normalisation. */
export function normalize(line: string): string {
  return line.trim().replace(/\s+/g, " ").replace(/[\s;,]+$/, "");
}

const DECORATOR = /^\s*(@|#\[|\[[A-Z]|\/\/|\/\*|\*|#(?!\[)|--|;;)/;

/**
 * How many leading lines of a body range are the signature: leading decorators/attributes/comments,
 * then the declaration up to where its brackets balance, plus a lone `{` on the next line (Allman style).
 */
export function signatureLineCount(lines: string[]): number {
  let i = 0;
  while (i < lines.length - 1 && (lines[i].trim() === "" || DECORATOR.test(lines[i]))) i++;
  let depth = 0;
  for (; i < lines.length; i++) {
    for (const c of lines[i]) {
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
    }
    if (depth <= 0) break;
  }
  i++;
  if (i < lines.length && /^\s*\{\s*$/.test(lines[i])) i++;
  return Math.min(Math.max(i, 1), lines.length);
}

const KEYWORDS = new Set("else try finally end return pass break continue do then fi done esac default begin except catch elif loop yield await async".split(" "));

function isTrivial(line: string): boolean {
  const toks = line.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  return toks.every((t) => KEYWORDS.has(t));
}

/** Comment and docstring lines describe intent, not implementation; they don't count as leaks. */
function commentMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inDoc: string | null = null;
  for (const l of lines) {
    const t = l.trim();
    if (inDoc) {
      mask.push(true);
      if (t.includes(inDoc)) inDoc = null;
      continue;
    }
    const q = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
    if (q) {
      mask.push(true);
      if (!(t.length >= 6 && t.slice(3).includes(q))) inDoc = q;
      continue;
    }
    mask.push(/^(\/\/|\/\*|\*|#(?!\[)|--|;;)/.test(t));
  }
  return mask;
}

export interface LeakOpts {
  common?: Set<string>;
  minLen?: number;
  threshold?: number;
}

export interface LeakTarget {
  id: string;
  file: string;
  body_lines: string[];
}

/** Normalised body lines that count for the line test. */
export function significantLines(t: LeakTarget, opts: LeakOpts = {}): string[] {
  const minLen = opts.minLen ?? 12;
  const mask = commentMask(t.body_lines);
  return [...new Set(t.body_lines.filter((l, i) => !mask[i] && l.length >= minLen && !isTrivial(l) && !opts.common?.has(l)))];
}

const tokens = (s: string) => s.split(/\W+/).filter(Boolean);

function shingles(toks: string[], k = 6): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= toks.length; i++) out.add(toks.slice(i, i + k).join(" "));
  return out;
}

export interface LeakFinding {
  target: string;
  body_line: string;
  text_line: number;
  text: string;
}

export interface LeakResult {
  passed: boolean;
  findings: LeakFinding[];
  shingle_ratio: number;
  shingle_target?: string;
}

/** engine-spec §6: line test + shingle test against every target body. */
export function checkLeak(text: string, targets: LeakTarget[], opts: LeakOpts = {}): LeakResult {
  const threshold = opts.threshold ?? 0.25;
  const textLines = text.split(/\r?\n/).map(normalize);
  const findings: LeakFinding[] = [];
  let worst = 0;
  let worstTarget: string | undefined;
  const textShingles = shingles(tokens(text));
  for (const t of targets) {
    for (const bl of significantLines(t, opts)) {
      textLines.forEach((tl, i) => {
        if (tl.includes(bl)) findings.push({ target: t.id, body_line: bl, text_line: i + 1, text: tl });
      });
    }
    const mask = commentMask(t.body_lines);
    const bodyShingles = shingles(tokens(t.body_lines.filter((_, i) => !mask[i]).join("\n")));
    if (bodyShingles.size) {
      let shared = 0;
      for (const s of bodyShingles) if (textShingles.has(s)) shared++;
      const ratio = shared / bodyShingles.size;
      if (ratio > worst) {
        worst = ratio;
        worstTarget = t.id;
      }
    }
  }
  return {
    passed: findings.length === 0 && worst <= threshold,
    findings,
    shingle_ratio: Math.round(worst * 1000) / 1000,
    ...(worstTarget ? { shingle_target: worstTarget } : {}),
  };
}

export const REDACTED = "[line from implementation redacted]";

/** Repair error text: replace offending lines instead of rejecting. */
export function redactLeaks(text: string, targets: LeakTarget[], opts: LeakOpts = {}): string {
  const sig = targets.flatMap((t) => significantLines(t, opts));
  return text
    .split(/\r?\n/)
    .map((l) => {
      const n = normalize(l);
      return sig.some((s) => n.includes(s)) ? REDACTED : l;
    })
    .join("\n");
}

export function formatFindings(r: LeakResult, where: string): string {
  const lines = r.findings.slice(0, 20).map((f) => `  ${where}:${f.text_line}: contains body line of ${f.target}: "${f.body_line}"`);
  if (r.findings.length > 20) lines.push(`  … and ${r.findings.length - 20} more`);
  if (!r.findings.length) lines.push(`  ${where}: shares ${Math.round(r.shingle_ratio * 100)}% of ${r.shingle_target}'s 6-token shingles`);
  return lines.join("\n");
}

/**
 * The 200 most common normalised lines across the repo's source files that occur in at least two files
 * (a line unique to one file is never boilerplate). Cached per run.
 */
export function commonLines(repo: Repo, runId: string | null): Set<string> {
  const cache = runId ? repo.p("runs", runId, "common-lines.json") : null;
  if (cache && fs.existsSync(cache)) return new Set(readJson<string[]>(cache));
  const minLen = repo.config.leak.min_line_length;
  const files = repo
    .git(["ls-files", "-z"], { allowFail: true })
    .split("\0")
    .filter((f) => f && matchGlobs(f, repo.config.source_globs));
  const counts = new Map<string, number>();
  for (const f of files) {
    const p = path.join(repo.root, f);
    try {
      if (fs.statSync(p).size > 1_000_000) continue;
      const seen = new Set(fs.readFileSync(p, "utf8").split(/\r?\n/).map(normalize).filter((l) => l.length >= minLen));
      for (const l of seen) counts.set(l, (counts.get(l) ?? 0) + 1);
    } catch {}
  }
  const top = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 200)
    .map(([l]) => l);
  if (cache) writeJson(cache, top);
  return new Set(top);
}
