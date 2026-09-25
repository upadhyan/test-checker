import * as fs from "node:fs";
import * as path from "node:path";
import { Repo } from "./repo";
import { loadClassification, QueueItem } from "./classify";
import { loadResults } from "./exec";
import { ERRORS_LABEL, Target, fileAt, loadRun, loadTarget, runDir } from "./run";
import { hunks } from "./dirty";
import { renderPrompt, storePayload } from "./payload";
import { configVars, loadSpec } from "./spec";
import { VERDICTS, Verdict, VerdictKind, effective, loadVerdicts, saveVerdicts } from "./verdicts";
import { nowIso, readJson, rejected, usage } from "./util";

export function queue(repo: Repo, runId: string) {
  const cls = loadClassification(repo, runId);
  if (!cls) throw usage(`run \`tcheck classify ${runId}\` first`);
  const v = loadVerdicts(repo, runId);
  return cls.queue.map((q) => {
    const e = effective(v[q.test]);
    return { ...q, status: e ? "decided" : "pending", ...(e ? { verdict: e.verdict, source: e.source } : {}) };
  });
}

/** Map a line range from one revision of a file to another through the diff hunks. */
export function mapRange(repo: Repo, from: string, to: string, file: string, [a, b]: [number, number]): [number, number] {
  if (from === to) return [a, b];
  const diff = repo.git(["diff", "-U0", from, to, "--", file], { allowFail: true });
  const map = (x: number, end: boolean) => {
    let delta = 0;
    for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const [os, ol, ns, nl] = [+m[1], m[2] === undefined ? 1 : +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
      if (ol === 0) {
        // pure insertion after old line `os`; an insertion right after the range's end belongs to it
        if (x > os || (end && x === os)) delta += nl;
        else break;
      } else if (x > os + ol - 1) delta += nl - ol;
      else if (x >= os) return end ? ns + Math.max(nl, 1) - 1 : ns;
      else break;
    }
    return x + delta;
  };
  const s = map(a, false);
  return [s, Math.max(s, map(b, true))];
}

/** The target's body at another revision (the implementation the adjudicator judges). */
export function bodyAt(repo: Repo, t: Target, commit: string): string {
  if (commit === t.commit) return t.body;
  const [a, b] = mapRange(repo, t.commit, commit, t.file, t.lines);
  const lines = fileAt(repo, commit, t.file).split(/\r?\n/);
  return lines.slice(a - 1, b).join("\n");
}

function queued(repo: Repo, runId: string, testId: string): QueueItem {
  const cls = loadClassification(repo, runId);
  const q = cls?.queue.find((x) => x.test === testId);
  if (!q) throw usage(`${testId} is not queued for adjudication in ${runId} (see \`tcheck adjudicate queue ${runId}\`)`);
  return q;
}

function composedSource(repo: Repo, runId: string, file: string): string {
  const composed = runDir(repo, runId, "composed", file);
  if (fs.existsSync(composed)) return fs.readFileSync(composed, "utf8");
  return fs.readFileSync(path.join(repo.root, file), "utf8");
}

export function adjudicatePrompt(repo: Repo, runId: string, testId: string) {
  const run = loadRun(repo, runId);
  const q = queued(repo, runId, testId);
  const results = loadResults(repo, runId);
  const label = ERRORS_LABEL[run.mode];
  const tr = results.labels[label]?.tests[testId];
  const anyTr = tr ?? Object.values(results.labels).map((l) => l.tests[testId]).find(Boolean);
  if (!anyTr) throw usage(`no results for ${testId}`);
  const targetId = testId.split("::")[0];
  const t = loadTarget(repo, runId, targetId);
  let testSource = composedSource(repo, runId, anyTr.file);
  for (const pair of q.pair ?? []) {
    const ex = results.labels[label].tests[pair];
    if (ex) testSource += `\n\n# --- existing test ${ex.name} (${ex.file}), which PASSES on the current code ---\n${composedSource(repo, runId, ex.file)}`;
  }
  const failure = tr
    ? [`Test: ${tr.name} (${tr.file})`, `Outcome on ${label}: ${tr.final}`, [tr.type, tr.message].filter(Boolean).join(": "), tr.text ?? ""].filter(Boolean).join("\n")
    : `Test: ${anyTr.name} produced no result on ${label} (${results.labels[label]?.timed_out.length ? "timeout" : "not collected"}).`;
  const commit = run.revisions[label];
  const analysisFile = runDir(repo, runId, "targets", targetId, "analysis.md");
  const vars = {
    ...configVars(repo, t),
    spec: loadSpec(repo, runId, targetId) ?? "(no spec saved)",
    analysis: fs.existsSync(analysisFile) ? fs.readFileSync(analysisFile, "utf8").trim() : "",
    test_source: testSource.trimEnd(),
    failure_output: failure.slice(0, 8000),
    target: { symbol: t.symbol, file: t.file, body: bodyAt(repo, t, commit) },
    revision: `${label} (${commit.slice(0, 10)})`,
  };
  const body = renderPrompt("adjudicate.md", vars, "adjudicate");
  return storePayload(repo, { role: "adjudicate", run: runId, target: targetId, test: testId }, body);
}

const tag = (text: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(text);
  return m ? m[1].trim() : null;
};

export function parseVerdict(raw: string): { verdict: VerdictKind; spec_basis: string; reason: string; warning?: string } {
  const v = (tag(raw, "verdict") ?? "").toLowerCase().replace(/[`*]/g, "").trim();
  if (!VERDICTS.includes(v as VerdictKind)) throw rejected(`<verdict> must be exactly one of ${VERDICTS.join(", ")}; got "${v || "(missing)"}"`);
  const spec_basis = tag(raw, "spec_basis") ?? "none";
  const reason = tag(raw, "reason") ?? "";
  if (v === "code-wrong" && /^(none|n\/a|)$/i.test(spec_basis.replace(/["'.]/g, "").trim())) {
    return { verdict: "spec-ambiguous", spec_basis, reason, warning: "code-wrong without a quoted spec sentence was downgraded to spec-ambiguous" };
  }
  return { verdict: v as VerdictKind, spec_basis, reason };
}

function applyQuarantine(repo: Repo, testId: string, on: boolean): void {
  repo.updateState((s) => {
    s.quarantined = s.quarantined.filter((q) => q !== testId);
    if (on) s.quarantined.push(testId);
  });
}

export function adjudicateSave(repo: Repo, runId: string, testId: string, raw: string) {
  queued(repo, runId, testId);
  const p = parseVerdict(raw);
  const v: Verdict = { ...p, source: "model", at: nowIso() };
  const all = loadVerdicts(repo, runId);
  all[testId] = { ...all[testId], model: v };
  saveVerdicts(repo, runId, all);
  if (!all[testId].override) applyQuarantine(repo, testId, v.verdict === "test-wrong");
  repo.ledger("verdict", { run: runId, test: testId, verdict: v.verdict, spec_basis: v.spec_basis, ...(v.warning ? { warning: v.warning } : {}) });
  return { test: testId, ...v, message: `Verdict recorded: ${v.verdict} for ${testId}.${v.warning ? ` Warning: ${v.warning}.` : ""}` };
}

export function adjudicateOverride(repo: Repo, runId: string, testId: string, verdict: string, reason: string) {
  if (!VERDICTS.includes(verdict as VerdictKind)) throw usage(`--verdict must be one of ${VERDICTS.join(", ")}`);
  if (!reason) throw usage("override needs --reason");
  loadRun(repo, runId);
  const v: Verdict = { verdict: verdict as VerdictKind, spec_basis: "user decision", reason, source: "user", at: nowIso() };
  const all = loadVerdicts(repo, runId);
  all[testId] = { ...all[testId], override: v };
  saveVerdicts(repo, runId, all);
  applyQuarantine(repo, testId, v.verdict === "test-wrong");
  repo.ledger("override", { run: runId, test: testId, verdict, reason });
  return { test: testId, ...v, message: `Override recorded: ${verdict} for ${testId}.` };
}

export { readJson };
