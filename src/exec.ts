import * as fs from "node:fs";
import * as path from "node:path";
import { Repo, Config } from "./repo";
import { Case, Outcome, readJUnitPath } from "./junit";
import { ComposedFile, ERRORS_LABEL, LABELS, RunJson, ensureWorktree, loadRun, runDir, saveRun, snapshotWorktree } from "./run";
import { EXIT, isWin, nowIso, readJson, shell, toPosix, usage, writeJson, RunResult } from "./util";

/** engine-spec §8.4 language-family defaults. */
export const DEFAULT_PATTERNS: Record<string, string[]> = {
  python: ["ImportError", "ModuleNotFoundError", "SyntaxError", "NameError", "fixture '.*' not found", "TypeError: .*__init__\\(\\)"],
  js: ["Cannot find module", "SyntaxError", "ReferenceError", "is not a constructor", "TS\\d{4}"],
  jvm: ["cannot find symbol", "NoClassDefFoundError", "ClassNotFoundException"],
  go: ["undefined:", "cannot use", "imported and not used"],
  rust: ["error\\[E\\d{4}\\]"],
};

const FAMILY: Record<string, string> = {
  python: "python",
  typescript: "js",
  javascript: "js",
  ts: "js",
  js: "js",
  java: "jvm",
  kotlin: "jvm",
  scala: "jvm",
  groovy: "jvm",
  go: "go",
  golang: "go",
  rust: "rust",
};

export function repairPatterns(cfg: Config): RegExp[] {
  const src = cfg.repair_error_patterns ?? DEFAULT_PATTERNS[FAMILY[cfg.language.toLowerCase()]] ?? Object.values(DEFAULT_PATTERNS).flat();
  return src.map((p) => new RegExp(p));
}

/** Env reaching test commands: essentials + toolchain vars + env_passthrough (config-reference "Environment"). */
export function commandEnv(cfg: Config): NodeJS.ProcessEnv {
  const keep = new Set([
    "PATH", "HOME", "LANG", "PYTHONPATH", "NODE_PATH", "GOPATH", "JAVA_HOME", "CARGO_HOME",
    // OS plumbing without which shells and toolchains misbehave
    "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL", "LC_ALL", "LC_CTYPE", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "PATHEXT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    ...cfg.env_passthrough,
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.has(k)) env[k] = v;
  return env;
}

const q = (p: string) => (/[\s"'$`\\]/.test(p) ? (isWin ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`) : p);

export function fillCommand(cmd: string, vars: Record<string, string>): string {
  return cmd.replace(/\{(files|junit|test_dir|root|per_test_seconds)\}/g, (m, k) => vars[k] ?? m);
}

export interface TestResult {
  id: string;
  target: string;
  file: string;
  classname: string;
  name: string;
  outcomes: (Outcome | null)[];
  final: Outcome | "flaky";
  type?: string;
  message?: string;
  text?: string;
  repairable?: boolean;
}

export interface LabelResult {
  commit: string;
  setup_error?: string;
  compile_error?: string;
  load_errors: { file: string; target: string; text: string }[];
  timed_out: number[];
  tests: Record<string, TestResult>;
  unmapped: number;
}

export interface Results {
  exec: number;
  at: string;
  labels: Record<string, LabelResult>;
  mutants?: Record<string, { file: string; killed_by: string[] }>;
}

export interface Repairable {
  kind: "compile" | "load" | "error";
  file?: string;
  test?: string;
  text: string;
}

interface RunFile {
  path: string;
  target: string;
  content: string;
}

/** Map a JUnit testcase back to the file (and target) it came from. */
export function mapCase(c: Case, files: RunFile[]): RunFile | undefined {
  const noExt = (p: string) => p.replace(/\.[^/.]+$/, "");
  const stem = (p: string) => path.posix.basename(p).split(".")[0];
  const tryName = (cn: string): RunFile | undefined => {
    if (!cn) return undefined;
    const asPath = cn.replace(/\\/g, "/");
    let hit = files.find((f) => asPath === f.path || asPath.endsWith("/" + f.path) || f.path.endsWith("/" + asPath) || noExt(asPath) === noExt(f.path));
    if (hit) return hit;
    hit = files.find((f) => {
      const dotted = noExt(f.path).replace(/\//g, ".");
      return cn === dotted || cn.startsWith(dotted + ".") || dotted.endsWith("." + cn);
    });
    if (hit) return hit;
    const segs = cn.split(/[./\\:]+/);
    const byStem = files.filter((f) => segs.includes(stem(f.path)));
    return byStem.length === 1 ? byStem[0] : undefined;
  };
  if (c.file) {
    const f = tryName(c.file);
    if (f) return f;
  }
  const f = tryName(c.classname) ?? (c.classname ? undefined : tryName(c.name));
  if (f) return f;
  const bare = c.name.replace(/\[.*$/, "").replace(/\(.*$/, "").split(/[./ ]/).pop() ?? "";
  if (bare.length >= 3) {
    const re = new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const byContent = files.filter((x) => re.test(x.content));
    if (byContent.length === 1) return byContent[0];
  }
  return files.length === 1 ? files[0] : undefined;
}

/** Is a failing testcase outcome a repairable (setup/compile/import) error? engine-spec §8.4 */
export function isRepairable(c: { outcome?: string; final?: string; type?: string; message?: string; text?: string }, patterns: RegExp[]): boolean {
  if ((c.outcome ?? c.final) !== "error") return false;
  const hay = [c.type, c.message, c.text?.split("\n").slice(-5).join("\n")].filter(Boolean).join("\n");
  return patterns.some((p) => p.test(hay));
}

const tail = (s: string, n = 4000) => (s.length > n ? "…" + s.slice(-n) : s);

export async function execRun(repo: Repo, runId: string, opts: { log?: (s: string) => void } = {}) {
  const run = loadRun(repo, runId);
  const cfg = repo.config;
  const log = opts.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const composedFile = runDir(repo, runId, "composed.json");
  if (!fs.existsSync(composedFile)) throw usage(`nothing composed for ${runId}; run \`tcheck compose ${runId}\` first`);
  const composed: ComposedFile[] = readJson(composedFile).files;
  const n = run.exec_count + 1;
  const env = commandEnv(cfg);
  const patterns = repairPatterns(cfg);
  const results: Results = { exec: n, at: nowIso(), labels: {} };

  const files: RunFile[] = [
    ...composed.map((f) => ({ path: f.path, target: f.target, content: fs.readFileSync(path.join(runDir(repo, runId, "composed"), f.path), "utf8") })),
    ...run.existing.map((p) => ({ path: p, target: "existing", content: fs.readFileSync(path.join(repo.root, p), "utf8") })),
  ];
  const testDir = composed.length ? path.posix.dirname(composed[0].path) : "";

  const runLabel = async (label: string, commit: string, reruns: number, patch?: string, only?: RunFile[]): Promise<LabelResult> => {
    const wt = ensureWorktree(repo, commit, patch ? `${commit}-mutant` : commit);
    const lr: LabelResult = { commit, load_errors: [], timed_out: [], tests: {}, unmapped: 0 };
    const labelFiles = only ?? files;
    for (const f of composed) {
      const src = path.join(runDir(repo, runId, "composed"), f.path);
      const dst = path.join(wt.dir, f.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      wt.meta.composed.push(f.path);
    }
    wt.saveMeta();
    if (patch) {
      const r = await shell("git apply --whitespace=nowarn -", { cwd: wt.dir, env: process.env, input: patch });
      if (r.code !== 0) {
        lr.setup_error = `mutant patch did not apply: ${tail(r.stderr, 500)}`;
        return lr;
      }
    }
    const vars = { files: labelFiles.map((f) => q(f.path)).join(" "), test_dir: testDir, root: wt.dir, junit: "", per_test_seconds: String(cfg.timeouts.per_test_seconds) };
    const timeout = cfg.timeouts.per_command_seconds;
    if (cfg.commands.setup && !wt.meta.setup_done) {
      log(`[${label}] setup: ${cfg.commands.setup}`);
      const r = await shell(fillCommand(cfg.commands.setup, vars), { cwd: wt.dir, env, timeoutSec: timeout });
      if (r.code !== 0) {
        lr.setup_error = tail(r.stdout + r.stderr);
        return lr;
      }
      wt.meta.setup_done = true;
      wt.saveMeta();
    }
    if (cfg.commands.compile) {
      log(`[${label}] compile: ${cfg.commands.compile}`);
      const r = await shell(fillCommand(cfg.commands.compile, vars), { cwd: wt.dir, env, timeoutSec: timeout });
      if (r.code !== 0) {
        lr.compile_error = tail(r.stdout + "\n" + r.stderr);
        return lr;
      }
    }
    const perRerun: Map<string, { c: Case; f: RunFile }>[] = [];
    for (let k = 1; k <= reruns; k++) {
      const kdir = runDir(repo, runId, "exec", String(n), label, String(k));
      fs.rmSync(kdir, { recursive: true, force: true });
      fs.mkdirSync(kdir, { recursive: true });
      const junit = path.join(kdir, "junit.xml");
      const cmd = fillCommand(cfg.commands.run, { ...vars, junit: q(junit) });
      log(`[${label}] run ${k}/${reruns}`);
      const r: RunResult = await shell(cmd, { cwd: wt.dir, env, timeoutSec: timeout });
      fs.writeFileSync(path.join(kdir, "output.txt"), `$ ${cmd}\nexit ${r.code}${r.timedOut ? " (timeout)" : ""}\n\n${r.stdout}\n${r.stderr}`);
      if (r.timedOut) lr.timed_out.push(k);
      const seen = new Map<string, { c: Case; f: RunFile }>();
      for (const c of readJUnitPath(kdir)) {
        const f = mapCase(c, labelFiles);
        if (!f) {
          lr.unmapped++;
          continue;
        }
        seen.set(`${f.target}::${c.classname}::${c.name}`, { c, f });
      }
      // A file with no test cases after a failed command is a load error, unless another file's own
      // collection error explains the abort (pytest stops the whole session on one bad file).
      const explained = [...seen.values()].some((s) => isRepairable(s.c, patterns));
      if (r.code !== 0 && !r.timedOut && !explained) {
        for (const f of labelFiles) {
          if (f.target === "existing") continue;
          if (![...seen.values()].some((s) => s.f === f) && !lr.load_errors.some((e) => e.file === f.path)) {
            lr.load_errors.push({ file: f.path, target: f.target, text: tail(r.stdout + "\n" + r.stderr) });
          }
        }
      }
      perRerun.push(seen);
      if (r.timedOut) break; // the next rerun would hang the same way
    }
    // Merge reruns: identical outcomes → that outcome; differing → flaky (engine-spec §8.3).
    const ids = new Set(perRerun.flatMap((m) => [...m.keys()]));
    for (const id of ids) {
      const outcomes = perRerun.map((m, i) => m.get(id)?.c.outcome ?? (lr.timed_out.includes(i + 1) ? "error" : null));
      const present = outcomes.filter((o): o is Outcome => o !== null);
      const first = perRerun.map((m) => m.get(id)).find(Boolean)!;
      const final: TestResult["final"] = new Set(present).size > 1 ? "flaky" : present[0];
      const c = first.c;
      lr.tests[id] = { id, target: first.f.target, file: first.f.path, classname: c.classname, name: c.name, outcomes, final, type: c.type, message: c.message, text: c.text ? tail(c.text) : undefined };
      if (isRepairable({ final, type: c.type, message: c.message, text: c.text }, patterns)) lr.tests[id].repairable = true;
    }
    return lr;
  };

  // Revisions given as WORKTREE are re-snapshotted, so a code fix after a code-wrong verdict is picked up.
  if (run.exec_count > 0) {
    for (const [label, given] of Object.entries(run.given)) {
      if (given !== "WORKTREE") continue;
      const sha = snapshotWorktree(repo, runId);
      if (sha !== run.revisions[label]) {
        repo.ledger("revision_refreshed", { run: runId, label, from: run.revisions[label], to: sha });
        run.revisions[label] = sha;
      }
    }
  }
  for (const label of LABELS[run.mode]) {
    results.labels[label] = await runLabel(label, run.revisions[label], cfg.flake_reruns);
  }

  // new mode + commands.mutate: each mutant plays the buggy version for the accepted tests.
  if (run.mode === "new" && cfg.commands.mutate) {
    results.mutants = await runMutants(repo, run, results, runLabel, log);
  }

  run.exec_count = n;
  saveRun(repo, run);
  writeJson(runDir(repo, runId, "exec", String(n), "results.json"), results);
  writeJson(runDir(repo, runId, "results.json"), results);
  const repair = repairableByTarget(run, results, patterns);
  writeJson(runDir(repo, runId, "repairable.json"), { exec: n, targets: repair });

  const status: Record<string, { status: "ok" | "needs_repair" | "failed_setup"; count?: number }> = {};
  const setupFailed = Object.values(results.labels).some((l) => l.setup_error);
  for (const t of run.targets) {
    if (setupFailed) status[t] = { status: "failed_setup" };
    else if (repair[t]?.length) status[t] = { status: "needs_repair", count: repair[t].length };
    else status[t] = { status: "ok" };
  }
  const summary = Object.fromEntries(
    Object.entries(results.labels).map(([l, r]) => {
      const counts: Record<string, number> = {};
      for (const t of Object.values(r.tests)) counts[t.final] = (counts[t.final] ?? 0) + 1;
      return [l, { ...counts, load_errors: r.load_errors.length, ...(r.compile_error ? { compile_error: true } : {}), ...(r.setup_error ? { setup_error: true } : {}) }];
    }),
  );
  repo.ledger("exec_completed", { run: runId, exec: n, labels: summary });
  return { exec: n, targets: status, labels: summary, setup_error: Object.entries(results.labels).find(([, l]) => l.setup_error)?.[1].setup_error, code: setupFailed ? EXIT.COMMAND : EXIT.OK };
}

export function repairableByTarget(run: RunJson, results: Results, patterns: RegExp[]): Record<string, Repairable[]> {
  const lr = results.labels[ERRORS_LABEL[run.mode]];
  const out: Record<string, Repairable[]> = {};
  if (!lr) return out;
  const add = (t: string, r: Repairable) => (out[t] ??= []).push(r);
  for (const t of run.targets) {
    if (lr.compile_error) add(t, { kind: "compile", text: lr.compile_error });
  }
  for (const e of lr.load_errors) add(e.target, { kind: "load", file: e.file, text: e.text });
  for (const t of Object.values(lr.tests)) {
    if (t.target !== "existing" && t.repairable) add(t.target, { kind: "error", file: t.file, test: t.name, text: [t.type, t.message, t.text].filter(Boolean).join(": ") });
  }
  void patterns;
  return out;
}

type RunLabelFn = (label: string, commit: string, reruns: number, patch?: string, only?: RunFile[]) => Promise<LabelResult>;

async function runMutants(repo: Repo, run: RunJson, results: Results, runLabel: RunLabelFn, log: (s: string) => void) {
  const cfg = repo.config;
  const current = results.labels.current;
  const accepted = Object.values(current.tests).filter((t) => t.final === "pass" && t.target !== "existing");
  const out: Record<string, { file: string; killed_by: string[] }> = {};
  if (!accepted.length) return out;
  const targetFiles = run.targets.map((t) => readJson(runDir(repo, run.id, "targets", t, "target.json")).file as string);
  const wt = ensureWorktree(repo, run.revisions.current);
  const r = await shell(fillCommand(cfg.commands.mutate!, { files: targetFiles.map(q).join(" "), root: wt.dir, test_dir: "", junit: "" }), {
    cwd: wt.dir,
    env: commandEnv(cfg),
    timeoutSec: cfg.timeouts.per_command_seconds,
  });
  if (r.code !== 0) {
    log(`mutate command failed: ${tail(r.stderr, 300)}`);
    return out;
  }
  const perFile = new Map<string, number>();
  const mutants = r.stdout
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((m) => m && m.id && m.patch)
    .filter((m) => {
      const c = (perFile.get(m.file) ?? 0) + 1;
      perFile.set(m.file, c);
      return c <= cfg.mutation.max_mutants_per_target;
    });
  for (const m of mutants) {
    const label = `mutant-${m.id}`;
    const lr = await runLabel(label, run.revisions.current, 1, m.patch);
    results.labels[label] = lr;
    const killed = accepted.filter((t) => lr.tests[t.id] && lr.tests[t.id].final !== "pass").map((t) => t.id);
    out[m.id] = { file: m.file, killed_by: killed };
  }
  return out;
}

export function loadResults(repo: Repo, runId: string): Results {
  const f = runDir(repo, runId, "results.json");
  if (!fs.existsSync(f)) throw usage(`no results for ${runId}; run \`tcheck exec ${runId}\``);
  return readJson(f);
}

export function relPosix(from: string, to: string): string {
  return toPosix(path.relative(from, to));
}
