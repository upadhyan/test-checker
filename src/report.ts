import * as fs from "node:fs";
import { Repo } from "./repo";
import { loadClassification } from "./classify";
import { loadResults } from "./exec";
import { ISOLATION, detectHarness, resolveBackend } from "./env";
import { loadRun, loadTarget, runDir, saveRun } from "./run";
import { planPromotion } from "./promote";
import { effective, loadVerdicts } from "./verdicts";
import { nowIso, readJson, usage, writeJson, writeText } from "./util";

const short = (id: string) => id.split("::").slice(1).join("::") || id;

export function buildReport(repo: Repo, runId: string, opts: { harness?: string } = {}) {
  const run = loadRun(repo, runId);
  const cls = loadClassification(repo, runId);
  if (!cls) throw usage(`run \`tcheck classify ${runId}\` first`);
  const results = loadResults(repo, runId);
  const verdicts = loadVerdicts(repo, runId);
  const harness = detectHarness(opts.harness);
  const backend = resolveBackend(repo.config.blind.backend, harness, repo.config.blind.api.key_env);
  const quarantined = new Set(repo.state().quarantined);
  const cats = run.mode === "bugfix" ? ["effective", "misguided", "neutral", "broken"] : ["accepted", "disputed"];

  const summary = run.targets.map((tid) => {
    const c = cls.counts[tid] ?? {};
    return {
      target: tid,
      ...Object.fromEntries(cats.map((k) => [k, c[k] ?? 0])),
      flaky: c.flaky ?? 0,
      dropped: cls.dropped.filter((d) => d.target === tid).length,
      ...(cls.kill_rate?.[tid] ? { mutant_kill_rate: `${cls.kill_rate[tid].killed}/${cls.kill_rate[tid].total}` } : {}),
    };
  });

  const testOf = (id: string) => cls.tests.find((t) => t.id === id);
  const failureOf = (id: string) => {
    for (const lr of Object.values(results.labels)) {
      const t = lr.tests[id];
      if (t && t.final !== "pass") return [t.type, t.message].filter(Boolean).join(": ").slice(0, 300);
    }
    return "";
  };
  const decided = Object.entries(verdicts).map(([test, e]) => ({ test, v: effective(e)! })).filter((x) => x.v);
  const likely_bugs = decided
    .filter((d) => d.v.verdict === "code-wrong")
    .map((d) => {
      const q = cls.queue.find((x) => x.test === d.test);
      return { test: d.test, target: d.test.split("::")[0], spec_basis: d.v.spec_basis, failure: failureOf(d.test), reason: d.v.reason, ...(q?.pair?.length ? { suspect_existing: q.pair } : {}) };
    });
  const suspicions = run.targets
    .map((tid) => {
      const f = runDir(repo, runId, "targets", tid, "analysis.md");
      return { target: tid, analysis: fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "" };
    })
    .filter((s) => s.analysis && !/^(logical mistakes:\s*none found\.?\s*robustness omissions:\s*none found\.?)$/i.test(s.analysis.replace(/\s+/g, " ")));
  const decisions = decided.filter((d) => d.v.verdict === "spec-ambiguous" && !verdicts[d.test].override).map((d) => ({ test: d.test, question: d.v.reason, spec_basis: d.v.spec_basis }));
  const misguided = cls.tests
    .filter((t) => t.category === "misguided" || t.category === "disputed")
    .map((t) => {
      const e = effective(verdicts[t.id]);
      return { test: t.id, category: t.category, outcome: e ? `${e.verdict}${e.source === "user" ? " (user)" : ""}` : "pending adjudication" };
    });
  const dropped = [
    ...cls.dropped.map((d) => ({ what: d.id ? short(d.id) : d.file!, target: d.target, reason: d.reason })),
    ...[...quarantined].filter((q) => testOf(q)).map((q) => ({ what: short(q), target: q.split("::")[0], reason: "quarantined (test-wrong)" })),
  ];
  const plan = planPromotion(repo, runId, { allAccepted: false });
  const data = {
    run: runId,
    mode: run.mode,
    revisions: Object.fromEntries(Object.entries(run.revisions).map(([l, sha]) => [l, { given: run.given[l], commit: sha }])),
    date: nowIso(),
    harness,
    blind_isolation: ISOLATION[backend],
    summary,
    likely_bugs,
    suspicions,
    needs_decision: decisions,
    misguided,
    dropped,
    promotable: plan.files.map((f) => ({ file: f.source, dest: f.dest, tests: f.tests.length })),
    not_promotable: plan.skipped,
  };
  return data;
}

type Report = ReturnType<typeof buildReport>;

function table(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "_none_";
  const cols = Object.keys(rows[0]);
  return [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`)].join("\n");
}

export function reportMarkdown(r: Report): string {
  const out: string[] = [];
  out.push(`# test-checker report ${r.run}`, "");
  out.push(`- Mode: ${r.mode}`);
  for (const [l, v] of Object.entries(r.revisions)) out.push(`- ${l}: ${v.given} → \`${v.commit.slice(0, 10)}\``);
  out.push(`- Date: ${r.date}`, `- Harness: ${r.harness}`, `- Blind isolation: ${r.blind_isolation}`, "");
  out.push("## Summary", "", table(r.summary), "");
  out.push("## Likely bugs", "");
  out.push(
    r.likely_bugs.length
      ? r.likely_bugs
          .map((b) => `- **${short(b.test)}** (${b.target})\n  - Spec: ${b.spec_basis}\n  - Failure: ${b.failure || "(none recorded)"}\n  - ${b.reason}${b.suspect_existing ? `\n  - suspect-existing: ${b.suspect_existing.map(short).join(", ")}` : ""}`)
          .join("\n")
      : "_none_",
    "",
  );
  out.push("## Suspicions", "", r.suspicions.length ? r.suspicions.map((s) => `### ${s.target}\n\n${s.analysis}`).join("\n\n") : "_none_", "");
  out.push("## Needs your decision", "", r.needs_decision.length ? r.needs_decision.map((d) => `- **${short(d.test)}**: ${d.question}\n  - Spec: ${d.spec_basis}`).join("\n") : "_none_", "");
  out.push("## Misguided tests and what happened to them", "", r.misguided.length ? r.misguided.map((m) => `- ${short(m.test)} (${m.category}): ${m.outcome}`).join("\n") : "_none_", "");
  out.push("## Dropped", "", r.dropped.length ? r.dropped.map((d) => `- ${d.what} (${d.target}): ${d.reason}`).join("\n") : "_none_", "");
  out.push("## Promotable tests", "");
  out.push(r.promotable.length ? r.promotable.map((p) => `- ${p.file} → \`${p.dest}\` (${p.tests} test(s))`).join("\n") : "_none_");
  if (r.not_promotable.length) out.push("", "Not promotable:", ...r.not_promotable.map((s) => `- ${s.file}: ${s.reason}`));
  return out.join("\n") + "\n";
}

export function consoleSummary(r: Report, mdPath: string): string {
  const lines = r.summary.map((s: any) => `${s.target}: ${Object.entries(s).filter(([k]) => k !== "target").map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const out = [
    ...lines.slice(0, 5),
    ...(lines.length > 5 ? [`… ${lines.length - 5} more target(s)`] : []),
    `likely bugs: ${r.likely_bugs.length}; needs your decision: ${r.needs_decision.length}; dropped: ${r.dropped.length}`,
    `promotable files: ${r.promotable.length}`,
    `report: ${mdPath}`,
  ];
  return out.slice(0, 10).join("\n");
}

export function report(repo: Repo, runId: string, opts: { harness?: string } = {}) {
  const r = buildReport(repo, runId, opts);
  const md = repo.p("reports", `${runId}.md`);
  writeText(md, reportMarkdown(r));
  writeJson(repo.p("reports", `${runId}.json`), r);
  const run = loadRun(repo, runId);
  run.status = "reported";
  saveRun(repo, run);
  repo.ledger("run_reported", { run: runId, likely_bugs: r.likely_bugs.length, needs_decision: r.needs_decision.length });
  return { report: r, path: repo.rel(md), summary: consoleSummary(r, repo.rel(md)) };
}

export { readJson, loadTarget };
