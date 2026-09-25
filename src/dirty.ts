import * as fs from "node:fs";
import * as path from "node:path";
import { Repo } from "./repo";
import { matchGlobs, nowIso, usage } from "./util";

/** Changed files per `git status --porcelain` (modified, added, untracked; renames → new path). */
function statusFiles(repo: Repo): string[] {
  const out = repo.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFail: true });
  const parts = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    files.push(e.slice(3));
    if (code[0] === "R" || code[0] === "C") i++; // skip the rename source
  }
  return files.filter((f) => !f.startsWith(".test-checker/"));
}

/** Blob shas of working-tree files, one git call. Missing files are omitted. */
export function blobShas(repo: Repo, files: string[]): Record<string, string> {
  const existing = files.filter((f) => fs.existsSync(path.join(repo.root, f)) && fs.statSync(path.join(repo.root, f)).isFile());
  if (!existing.length) return {};
  const shas = repo.git(["hash-object", "--", ...existing]).trim().split(/\r?\n/);
  return Object.fromEntries(existing.map((f, i) => [f, shas[i]]));
}

/** engine-spec §10 dirty files. */
export function dirtyFiles(repo: Repo): string[] {
  const globs = repo.config.source_globs;
  const changed = statusFiles(repo).filter((f) => matchGlobs(f, globs));
  const shas = blobShas(repo, changed);
  const verified = repo.state().verified;
  return changed.filter((f) => shas[f] && verified[f]?.sha !== shas[f]).sort();
}

export interface ScopeEntry {
  file: string;
  ranges: [number, number][];
  verified: boolean;
  untracked?: boolean;
}

/** `tcheck scope [--since REV]`: changed source files with new-side hunk ranges. */
export function scope(repo: Repo, since = "HEAD"): ScopeEntry[] {
  const base = repo.commit(since);
  const globs = repo.config.source_globs;
  const tracked = repo.git(["diff", "--name-only", "-z", base, "--"]).split("\0").filter(Boolean);
  const untracked = repo.git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].filter((f) => !f.startsWith(".test-checker/") && matchGlobs(f, globs)).sort();
  const shas = blobShas(repo, files);
  const verified = repo.state().verified;
  return files
    .filter((f) => shas[f]) // deleted files have nothing to test
    .map((file) => {
      const isNew = untracked.includes(file);
      let ranges: [number, number][];
      if (isNew) {
        const n = fs.readFileSync(path.join(repo.root, file), "utf8").split("\n").length;
        ranges = [[1, n]];
      } else ranges = hunks(repo.git(["diff", "-U0", base, "--", file]));
      return { file, ranges, verified: verified[file]?.sha === shas[file], ...(isNew ? { untracked: true } : {}) };
    });
}

/** New-side line ranges from a -U0 diff. Pure deletions yield the line they sit before. */
export function hunks(diff: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = parseInt(m[1], 10);
    const len = m[2] === undefined ? 1 : parseInt(m[2], 10);
    out.push(len === 0 ? [Math.max(start, 1), Math.max(start, 1)] : [start, start + len - 1]);
  }
  return out;
}

export function waive(repo: Repo, paths: string[], reason: string): string[] {
  if (!reason) throw usage("waive needs --reason");
  const rels = paths.map((p) => repo.rel(p));
  const shas = blobShas(repo, rels);
  const missing = rels.filter((r) => !shas[r]);
  if (missing.length) throw usage(`not a file: ${missing.join(", ")}`);
  const at = nowIso();
  repo.updateState((s) => {
    for (const r of rels) s.verified[r] = { sha: shas[r], run: null, at, waived: reason };
  });
  repo.ledger("waived", { files: rels, reason });
  return rels;
}
