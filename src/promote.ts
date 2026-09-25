import * as fs from "node:fs";
import * as path from "node:path";
import { Repo } from "./repo";
import { Classified, loadClassification } from "./classify";
import { ComposedFile, ERRORS_LABEL, expandPath, loadRun, loadTarget, runDir } from "./run";
import { unresolved } from "./verdicts";
import { EXIT, TcheckError, nowIso, readJson, usage, writeText } from "./util";

export interface PlannedFile {
  source: string;
  dest: string;
  target: string;
  tests: string[];
}

/**
 * Which composed files can be promoted. Promotion is per file (test frameworks can't be sliced
 * language-agnostically), so a file qualifies only when every test in it is acceptable:
 * bugfix → effective or neutral; new/audit → accepted. It must also hold a selected test:
 * effective/accepted by default, any acceptable test with --all-accepted, or ids from --tests.
 */
export function planPromotion(repo: Repo, runId: string, opts: { tests?: string[]; allAccepted?: boolean } = {}) {
  const run = loadRun(repo, runId);
  const cls = loadClassification(repo, runId);
  if (!cls) throw usage(`run \`tcheck classify ${runId}\` first`);
  const cfg = repo.config;
  const quarantined = new Set(repo.state().quarantined);
  const composed: ComposedFile[] = readJson(runDir(repo, runId, "composed.json"), { files: [] }).files;
  const acceptable = new Set(run.mode === "bugfix" ? ["effective", "neutral"] : ["accepted"]);
  const selected = (t: Classified) =>
    opts.tests?.length ? opts.tests.includes(t.id) : opts.allAccepted ? acceptable.has(t.category) : run.mode === "bugfix" ? t.category === "effective" : t.category === "accepted";
  const files: PlannedFile[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const f of composed) {
    const tests = cls.tests.filter((t) => t.file === f.path && !t.existing);
    if (!tests.length) {
      skipped.push({ file: f.path, reason: "no test results" });
      continue;
    }
    const bad = tests.filter((t) => !acceptable.has(t.category) || quarantined.has(t.id));
    if (bad.length) {
      skipped.push({ file: f.path, reason: `contains non-accepted tests: ${bad.map((t) => `${t.name} (${quarantined.has(t.id) ? "quarantined" : t.category})`).join(", ")}` });
      continue;
    }
    if (!tests.some(selected)) {
      skipped.push({ file: f.path, reason: run.mode === "bugfix" ? "only neutral tests (use --all-accepted to include)" : "not selected" });
      continue;
    }
    if (!cfg.promote_dir) throw new TcheckError("promote_dir is not set in .test-checker/config.yaml", EXIT.USAGE);
    const t = loadTarget(repo, runId, f.target);
    files.push({ source: f.path, dest: path.posix.join(expandPath(cfg.promote_dir, t), path.posix.basename(f.path)), target: f.target, tests: tests.map((x) => x.id) });
  }
  return { files, skipped };
}

export function promote(repo: Repo, runId: string, opts: { tests?: string[]; allAccepted?: boolean; force?: boolean } = {}) {
  const run = loadRun(repo, runId);
  const blocking = unresolved(repo, runId);
  if (blocking.length && !opts.force) {
    throw new TcheckError(
      `refusing to promote: unresolved verdicts\n${blocking.map((b) => `  ${b.verdict}: ${b.test}`).join("\n")}\nFix the code and re-run exec (code-wrong), or ask the user and record \`tcheck adjudicate override\` / \`tcheck spec edit\` (spec-ambiguous). --force skips this check.`,
      EXIT.REJECTED,
    );
  }
  const plan = planPromotion(repo, runId, opts);
  if (!plan.files.length) return { promoted: [], skipped: plan.skipped, verified: [] as string[] };
  for (const f of plan.files) {
    const dest = path.join(repo.root, f.dest);
    const content = fs.readFileSync(runDir(repo, runId, "composed", f.source), "utf8");
    if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") !== content && !opts.force) {
      throw new TcheckError(`${f.dest} already exists with different content (--force to overwrite)`, EXIT.REJECTED);
    }
    writeText(dest, content);
  }
  // The verified snapshot is the blob that was actually tested (fixed side, or current snapshot).
  const commit = run.revisions[ERRORS_LABEL[run.mode]];
  const verified: string[] = [];
  const at = nowIso();
  repo.updateState((s) => {
    for (const f of plan.files) s.protected[f.dest] = { test_ids: f.tests, run: runId };
    for (const tid of run.targets) {
      const file = loadTarget(repo, runId, tid).file;
      const sha = repo.git(["rev-parse", `${commit}:${file}`], { allowFail: true }).trim();
      if (sha) {
        s.verified[file] = { sha, run: runId, at };
        verified.push(file);
      }
    }
  });
  repo.ledger("promoted", { run: runId, files: plan.files.map((f) => f.dest), verified });
  return { promoted: plan.files, skipped: plan.skipped, verified };
}
