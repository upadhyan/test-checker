import { Repo } from "./repo";
import { loadResults, LabelResult, TestResult } from "./exec";
import { ERRORS_LABEL, loadRun, loadTarget, runDir } from "./run";
import { nowIso, readJson, writeJson } from "./util";
import * as fs from "node:fs";

export type Category =
  | "effective" | "misguided" | "neutral" | "broken" // bugfix
  | "accepted" | "disputed" // new / audit
  | "flaky" | "skipped" | "unrepairable";

export interface Classified {
  id: string;
  target: string;
  file: string;
  name: string;
  category: Category;
  outcomes: Record<string, string>;
  extra?: string[];
  existing?: boolean;
}

export interface QueueItem {
  test: string;
  category: Category;
  reason: string;
  revision: string;
  pair?: string[];
}

export interface Classification {
  run: string;
  exec: number;
  mode: string;
  at: string;
  tests: Classified[];
  queue: QueueItem[];
  counts: Record<string, Record<string, number>>;
  dropped: { id?: string; file?: string; target: string; reason: string }[];
  kill_rate?: Record<string, { killed: number; total: number }>;
}

function outcomeOf(lr: LabelResult | undefined, id: string): string {
  if (!lr) return "missing";
  const t = lr.tests[id];
  if (t) return t.final;
  return lr.timed_out.length ? "timeout" : lr.compile_error ? "compile-error" : "missing";
}

const passed = (o: string) => o === "pass";

export function classify(repo: Repo, runId: string): Classification {
  const run = loadRun(repo, runId);
  const res = loadResults(repo, runId);
  const errLabel = ERRORS_LABEL[run.mode];
  const tests: Classified[] = [];
  const queue: QueueItem[] = [];
  const dropped: Classification["dropped"] = [];
  const all = new Map<string, TestResult>();
  for (const [label, lr] of Object.entries(res.labels)) {
    if (label.startsWith("mutant-")) continue;
    for (const t of Object.values(lr.tests)) if (!all.has(t.id)) all.set(t.id, t);
  }
  const errLr = res.labels[errLabel];
  for (const e of errLr?.load_errors ?? []) dropped.push({ file: e.file, target: e.target, reason: "load error (no test cases produced)" });

  for (const t of all.values()) {
    const outcomes: Record<string, string> = {};
    for (const label of Object.keys(res.labels)) if (!label.startsWith("mutant-")) outcomes[label] = outcomeOf(res.labels[label], t.id);
    const c: Classified = { id: t.id, target: t.target, file: t.file, name: t.name, category: "neutral", outcomes };
    const vals = Object.values(outcomes);
    if (t.target === "existing") {
      c.existing = true;
      c.category = vals.includes("flaky") ? "flaky" : passed(outcomes.current) ? "accepted" : "disputed";
      tests.push(c);
      continue;
    }
    if (vals.includes("flaky")) c.category = "flaky";
    else if (vals.includes("skipped")) c.category = "skipped";
    else if (errLr?.tests[t.id]?.repairable) c.category = "unrepairable";
    else if (run.mode === "bugfix") {
      const F = passed(outcomes.fixed);
      const B = passed(outcomes.buggy);
      c.category = F && !B ? "effective" : !F && B ? "misguided" : F && B ? "neutral" : "broken";
    } else c.category = passed(outcomes.current) ? "accepted" : "disputed";
    tests.push(c);
    if (c.category === "flaky") dropped.push({ id: c.id, target: c.target, reason: "flaky across reruns" });
    if (c.category === "unrepairable") dropped.push({ id: c.id, target: c.target, reason: "setup/import error after repair rounds" });
    if (c.category === "misguided" || c.category === "broken") {
      queue.push({ test: c.id, category: c.category, reason: c.category === "misguided" ? "fails on the fixed revision but passes on the buggy one" : "fails on both revisions", revision: "fixed" });
    }
    if (c.category === "disputed") queue.push({ test: c.id, category: c.category, reason: "fails on the current code", revision: "current" });
  }

  // audit: pair disputed blind tests with passing existing tests that mention the same unit.
  if (run.mode === "audit") {
    const existing = tests.filter((t) => t.existing && t.category === "accepted");
    for (const qi of queue) {
      const bt = tests.find((t) => t.id === qi.test)!;
      const target = loadTarget(repo, runId, bt.target);
      const unit = target.symbol.split(/[.:#]/).pop()!;
      const re = new RegExp(`\\b${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      const pair = existing.filter((e) => re.test(fs.readFileSync(`${repo.root}/${e.file}`, "utf8"))).map((e) => e.id);
      if (pair.length) {
        qi.pair = pair;
        qi.reason += `; existing test(s) on the same unit pass: ${pair.map((p) => p.split("::").pop()).join(", ")}`;
      }
    }
  }

  // Mutation: accepted tests that kill a mutant are also effective.
  let kill_rate: Classification["kill_rate"];
  if (res.mutants) {
    kill_rate = {};
    const killers = new Set(Object.values(res.mutants).flatMap((m) => m.killed_by));
    for (const t of tests) if (t.category === "accepted" && killers.has(t.id)) t.extra = [...(t.extra ?? []), "effective"];
    for (const tid of run.targets) {
      const file = loadTarget(repo, runId, tid).file;
      const ms = Object.values(res.mutants).filter((m) => m.file === file);
      kill_rate[tid] = { killed: ms.filter((m) => m.killed_by.length).length, total: ms.length };
    }
  }

  const counts: Classification["counts"] = {};
  for (const t of tests) {
    const k = t.existing ? "existing" : t.target;
    counts[k] ??= {};
    counts[k][t.category] = (counts[k][t.category] ?? 0) + 1;
  }
  const out: Classification = { run: runId, exec: res.exec, mode: run.mode, at: nowIso(), tests, queue, counts, dropped, ...(kill_rate ? { kill_rate } : {}) };
  writeJson(runDir(repo, runId, "classification.json"), out);
  repo.ledger("classified", { run: runId, exec: res.exec, counts, queued: queue.length });
  return out;
}

export function loadClassification(repo: Repo, runId: string): Classification | null {
  const f = runDir(repo, runId, "classification.json");
  return fs.existsSync(f) ? readJson(f) : null;
}
