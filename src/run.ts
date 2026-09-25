import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Repo } from "./repo";
import { EXIT, TcheckError, gitOk, listFilesRecursive, nowIso, randHex, readJson, rejected, sha256, slug, usage, writeJson, writeText } from "./util";
import { normalize, signatureLineCount } from "./leak";

export type Mode = "bugfix" | "new" | "audit";

export interface RunJson {
  id: string;
  mode: Mode;
  created_at: string;
  status: "open" | "reported";
  /** label → commit sha */
  revisions: Record<string, string>;
  /** label → how it was given (a rev, or WORKTREE) */
  given: Record<string, string>;
  spec_source: string;
  existing: string[];
  targets: string[];
  exec_count: number;
}

export interface Target {
  id: string;
  file: string;
  symbol: string;
  lines: [number, number];
  rev: string;
  commit: string;
  body: string;
  body_sha: string;
  /** normalised body lines, signature excluded (leak check input) */
  body_lines: string[];
  signature: string;
}

export const LABELS: Record<Mode, string[]> = { bugfix: ["buggy", "fixed"], new: ["current"], audit: ["current"] };
/** Revision whose errors feed repair and adjudication (engine-spec §8.4). */
export const ERRORS_LABEL: Record<Mode, string> = { bugfix: "fixed", new: "current", audit: "current" };

export function runDir(repo: Repo, runId: string, ...p: string[]): string {
  return repo.p("runs", runId, ...p);
}

export function loadRun(repo: Repo, runId: string): RunJson {
  const f = runDir(repo, runId, "run.json");
  if (!fs.existsSync(f)) throw usage(`unknown run: ${runId}`);
  return readJson(f);
}

export function saveRun(repo: Repo, run: RunJson): void {
  writeJson(runDir(repo, run.id, "run.json"), run);
}

export function listRuns(repo: Repo): RunJson[] {
  const d = repo.p("runs");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((r) => fs.existsSync(path.join(d, r, "run.json")))
    .sort()
    .map((r) => readJson<RunJson>(path.join(d, r, "run.json")));
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `r-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randHex(4)}`;
}

/** engine-spec §8.1: commit the working tree (incl. untracked) without touching the user's index. */
export function snapshotWorktree(repo: Repo, runId: string): string {
  const head = repo.commit("HEAD");
  const idx = path.join(os.tmpdir(), `tcheck-index-${randHex(8)}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    repo.git(["read-tree", "HEAD"], { env });
    repo.git(["add", "-A", "--", ".", ":!.test-checker"], { env });
    const tree = repo.git(["write-tree"], { env }).trim();
    const ident = { GIT_AUTHOR_NAME: "tcheck", GIT_AUTHOR_EMAIL: "tcheck@localhost", GIT_COMMITTER_NAME: "tcheck", GIT_COMMITTER_EMAIL: "tcheck@localhost" };
    const commit = repo.git(["commit-tree", tree, "-p", head, "-m", "tcheck-snapshot"], { env: { ...process.env, ...ident } }).trim();
    repo.git(["update-ref", `refs/tcheck/${runId}/worktree`, commit]);
    return commit;
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

export function runStart(repo: Repo, opts: { mode: string; buggy?: string; fixed?: string; existing?: string[] }): RunJson {
  const mode = opts.mode as Mode;
  if (!LABELS[mode]) throw usage("--mode must be bugfix, new or audit");
  repo.config; // validate before creating anything
  if (!gitOk(repo.root, ["rev-parse", "--verify", "HEAD"])) throw new TcheckError("the repository has no commits yet", EXIT.ENV);
  const id = newRunId();
  const revisions: Record<string, string> = {};
  const given: Record<string, string> = {};
  const resolve = (label: string, rev: string) => {
    given[label] = rev;
    revisions[label] = rev === "WORKTREE" ? snapshotWorktree(repo, id) : repo.commit(rev);
  };
  if (mode === "bugfix") {
    resolve("buggy", opts.buggy ?? "HEAD");
    resolve("fixed", opts.fixed ?? "WORKTREE");
  } else {
    if (opts.buggy || opts.fixed) throw usage(`--buggy/--fixed only apply to bugfix mode`);
    resolve("current", "WORKTREE");
  }
  const existing = (opts.existing ?? []).map((p) => repo.rel(p));
  if (mode === "audit" && !existing.length) throw usage("audit mode needs --existing <test paths>");
  for (const e of existing) if (!fs.existsSync(path.join(repo.root, e))) throw usage(`--existing path not found: ${e}`);
  const run: RunJson = {
    id,
    mode,
    created_at: nowIso(),
    status: "open",
    revisions,
    given,
    spec_source: mode === "bugfix" ? repo.config.spec.source : "current",
    existing,
    targets: [],
    exec_count: 0,
  };
  saveRun(repo, run);
  repo.ledger("run_started", { run: id, mode, revisions, given });
  return run;
}

// ---------------- targets ----------------

export function targetId(file: string, symbol: string): string {
  return `${slug(file)}--${slug(symbol)}`;
}

export function fileAt(repo: Repo, commit: string, file: string): string {
  const r = repo.git(["show", `${commit}:${file}`], { allowFail: true });
  if (!r && !gitOk(repo.root, ["cat-file", "-e", `${commit}:${file}`])) throw usage(`${file} does not exist at ${commit.slice(0, 10)}`);
  return r;
}

export function targetAdd(repo: Repo, runId: string, spec: string, linesArg: string, rev?: string): Target {
  const run = loadRun(repo, runId);
  const m = /^(.+?)::(.+)$/.exec(spec);
  if (!m) throw usage("target must be <file>::<symbol>");
  const file = repo.rel(m[1]);
  const symbol = m[2];
  const lm = /^(\d+)-(\d+)$/.exec(linesArg ?? "");
  if (!lm) throw usage("--lines must be A-B");
  const a = parseInt(lm[1], 10);
  const b = parseInt(lm[2], 10);
  const label = rev ?? run.spec_source;
  const commit = run.revisions[label] ?? repo.commit(label);
  const text = fileAt(repo, commit, file);
  const all = text.split(/\r?\n/);
  if (text.endsWith("\n")) all.pop();
  if (a < 1 || b < a || b > all.length) throw usage(`--lines ${a}-${b} is empty or outside ${file} (${all.length} lines at ${label})`);
  const bodyArr = all.slice(a - 1, b);
  if (!bodyArr.some((l) => l.trim())) throw usage(`--lines ${a}-${b} of ${file} is blank`);
  const body = bodyArr.join("\n");
  const sigCount = signatureLineCount(bodyArr);
  const id = targetId(file, symbol);
  const t: Target = {
    id,
    file,
    symbol,
    lines: [a, b],
    rev: label,
    commit,
    body,
    body_sha: sha256(body),
    body_lines: bodyArr.slice(sigCount).map(normalize),
    signature: bodyArr.slice(0, sigCount).join("\n"),
  };
  writeJson(runDir(repo, runId, "targets", id, "target.json"), t);
  if (!run.targets.includes(id)) run.targets.push(id);
  saveRun(repo, run);
  repo.ledger("target_added", { run: runId, target: id, file, symbol, lines: [a, b], rev: label, body_sha: t.body_sha });
  return t;
}

export function loadTarget(repo: Repo, runId: string, targetIdArg: string): Target {
  const f = runDir(repo, runId, "targets", targetIdArg, "target.json");
  if (!fs.existsSync(f)) throw usage(`unknown target ${targetIdArg} in run ${runId}`);
  return readJson(f);
}

// ---------------- worktrees (engine-spec §8.1) ----------------

interface WorktreeMeta {
  setup_done: boolean;
  composed: string[];
}

/** A cached worktree per commit sha, reused across runs. */
export function ensureWorktree(repo: Repo, sha: string, key = sha): { dir: string; meta: WorktreeMeta; fresh: boolean; saveMeta: () => void } {
  const dir = repo.p("worktrees", "_cache", key);
  const metaFile = repo.p("worktrees", "_cache", `${key}.json`);
  let fresh = false;
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    repo.git(["worktree", "prune"], { allowFail: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    repo.git(["worktree", "add", "--detach", "--force", dir, sha]);
    fs.rmSync(metaFile, { force: true });
    fresh = true;
  }
  const meta: WorktreeMeta = readJson(metaFile, { setup_done: false, composed: [] });
  // Undo the previous round: our files out, tracked files back to the commit.
  for (const f of meta.composed) fs.rmSync(path.join(dir, f), { force: true });
  meta.composed = [];
  repo.git(["-C", dir, "checkout", "--force", "--detach", sha], { allowFail: true });
  repo.git(["-C", dir, "checkout", "--", "."], { allowFail: true });
  return { dir, meta, fresh, saveMeta: () => writeJson(metaFile, meta) };
}

// ---------------- placeholders + compose (engine-spec §8.2) ----------------

function words(symbol: string): string[] {
  return symbol
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function packagePath(file: string): string {
  const dir = path.posix.dirname(file);
  const m = /(?:^|\/)(?:java|kotlin|scala|groovy)\/(.*)$/.exec(dir);
  return m ? m[1] : dir === "." ? "" : dir;
}

export function expandPath(template: string, t: { id: string; file: string; symbol: string }, n?: number): string {
  const w = words(t.symbol);
  const vals: Record<string, string> = {
    symbol: w.map((x) => x.toLowerCase()).join("_"),
    Symbol: w.map((x) => x[0].toUpperCase() + x.slice(1)).join(""),
    target_slug: t.id.replace(/-/g, "_"),
    pkg_dir: path.posix.dirname(t.file),
    package_path: packagePath(t.file),
  };
  if (n !== undefined) vals.n = String(n);
  return template.replace(/\{(\w+)\}/g, (m, k) => vals[k] ?? m).replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

/** The shape a submitted file name must have: the pattern's fixed prefix and suffix. */
export function nameShape(pattern: string, t: { id: string; file: string; symbol: string }): { prefix: string; suffix: string; example: string } {
  const expanded = expandPath(pattern, t);
  const first = expanded.indexOf("{");
  const last = expanded.lastIndexOf("}");
  return {
    prefix: first < 0 ? expanded : expanded.slice(0, first),
    suffix: last < 0 ? "" : expanded.slice(last + 1),
    example: expandPath(pattern, t, 1),
  };
}

export function checkFileName(name: string, pattern: string, t: Target): string | null {
  if (!name || /[\\/]/.test(name) || name.includes("..") || name.startsWith(".")) return `"${name}": use a plain file name (no directories)`;
  const s = nameShape(pattern, t);
  if (!name.startsWith(s.prefix) || !name.endsWith(s.suffix) || name.length < s.prefix.length + s.suffix.length) {
    return `"${name}" does not match the naming pattern (e.g. ${s.example})`;
  }
  return null;
}

/** Bookkeeping files stored beside submitted tests in a round directory. */
export const isRoundMeta = (name: string) => name === "notes.md" || name === "round.json";

export function generatedDir(repo: Repo, runId: string, targetIdArg: string, round?: number): string {
  const base = repo.p("generated", runId, targetIdArg);
  return round === undefined ? base : path.join(base, `round-${round}`);
}

export function latestRound(repo: Repo, runId: string, targetIdArg: string): number | null {
  const base = generatedDir(repo, runId, targetIdArg);
  if (!fs.existsSync(base)) return null;
  const rounds = fs
    .readdirSync(base)
    .map((d) => /^round-(\d+)$/.exec(d))
    .filter(Boolean)
    .map((m) => parseInt(m![1], 10));
  return rounds.length ? Math.max(...rounds) : null;
}

export interface ComposedFile {
  /** worktree-relative final path */
  path: string;
  target: string;
  round: number;
  source: string;
}

export function compose(repo: Repo, runId: string): { files: ComposedFile[]; missing: string[] } {
  const run = loadRun(repo, runId);
  const cfg = repo.config;
  const files: ComposedFile[] = [];
  const missing: string[] = [];
  const outDir = runDir(repo, runId, "composed");
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const tid of run.targets) {
    const t = loadTarget(repo, runId, tid);
    const round = latestRound(repo, runId, tid);
    if (round === null) {
      missing.push(tid);
      continue;
    }
    const dir = expandPath(cfg.test_dir, t);
    for (const src of listFilesRecursive(generatedDir(repo, runId, tid, round))) {
      const name = path.basename(src);
      if (isRoundMeta(name)) continue;
      const final = path.posix.join(dir, name);
      const clash = files.find((f) => f.path === final);
      if (clash) throw rejected(`two targets produced the same test file ${final} (${clash.target}, ${tid}); use {target_slug} in test_file_pattern`);
      files.push({ path: final, target: tid, round, source: path.relative(repo.root, src) });
      writeText(path.join(outDir, final), fs.readFileSync(src, "utf8"));
    }
  }
  if (!files.length) throw usage(`no submitted tests to compose in ${runId}${missing.length ? ` (waiting on: ${missing.join(", ")})` : ""}`);
  writeJson(runDir(repo, runId, "composed.json"), { at: nowIso(), files });
  return { files, missing };
}
