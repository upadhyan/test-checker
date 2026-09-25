import * as fs from "node:fs";
import { listFilesRecursive } from "./util";

export type Outcome = "pass" | "failure" | "error" | "skipped";

export interface Case {
  classname: string;
  name: string;
  file?: string;
  outcome: Outcome;
  type?: string;
  message?: string;
  text?: string;
}

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3] ?? "");
  return out;
}

/** Tolerant JUnit XML reader: every <testcase> with its failure/error/skipped child. */
export function parseJUnit(xml: string): Case[] {
  const cases: Case[] = [];
  let cur: Case | null = null;
  let child: "failure" | "error" | "skipped" | null = null;
  let buf = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(xml)); ) {
    if (child) buf += decode(xml.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      if (child) buf += m[1];
      continue;
    }
    const [, , close, tag, attrText, selfClose] = m;
    if (!tag) continue;
    if (!close && tag === "testcase") {
      const a = attrs(attrText);
      cur = { classname: a.classname ?? "", name: a.name ?? "", outcome: "pass", ...(a.file ? { file: a.file } : {}) };
      if (selfClose) {
        cases.push(cur);
        cur = null;
      }
    } else if (close && tag === "testcase" && cur) {
      cases.push(cur);
      cur = null;
    } else if (cur && !close && (tag === "failure" || tag === "error" || tag === "skipped")) {
      const a = attrs(attrText);
      // A test that errored and failed counts as the more severe outcome already set.
      if (cur.outcome === "pass" || tag !== "skipped") cur.outcome = tag;
      if (a.type) cur.type = a.type;
      if (a.message) cur.message = a.message;
      if (!selfClose) {
        child = tag;
        buf = "";
      }
    } else if (close && child && tag === child && cur) {
      cur.text = (cur.text ? cur.text + "\n" : "") + buf.trim();
      child = null;
    }
  }
  return cases;
}

/** Read every XML file at a path (file or directory). */
export function readJUnitPath(p: string): Case[] {
  if (!fs.existsSync(p)) return [];
  const files = fs.statSync(p).isDirectory() ? listFilesRecursive(p).filter((f) => f.endsWith(".xml")) : [p];
  return files.flatMap((f) => parseJUnit(fs.readFileSync(f, "utf8")));
}
