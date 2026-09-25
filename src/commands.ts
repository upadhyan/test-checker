// Registers every command beyond the setup basics in cli.ts.
import { register, str, list, bool, Args } from "./cli";
import { Repo } from "./repo";
import { runStart, targetAdd, compose } from "./run";
import { execRun } from "./exec";
import { classify } from "./classify";
import { readInput, usage } from "./util";
import { contextSet, specEdit, specPrompt, specSave, specShow } from "./spec";
import { bundleBuild, bundleEmit, ingest } from "./bundle";
import { adjudicateOverride, adjudicatePrompt, adjudicateSave, queue } from "./adjudicate";
import { report } from "./report";
import { promote } from "./promote";
import { runHookCli } from "./hooks";
import { serve } from "./mcp";

const repoOf = (a: Args) => Repo.open({ root: str(a, "root") });
function need(a: Args, i: number, name: string): string {
  const v = a._[i];
  if (!v) throw usage(`missing <${name}>`);
  return v;
}

register("doctor", async (a) => {
  const repo = Repo.open({ root: str(a, "root") });
  const r = await (await import("./doctor")).doctor(repo, { use: list(a, "use"), log: bool(a, "json") || bool(a, "quiet") ? () => {} : undefined });
  const human = [
    ...r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}${c.fix ? `\n     fix: ${c.fix}` : ""}`),
    r.ok ? "doctor: all checks passed." : "doctor: fix the failing checks and run again.",
  ].join("\n");
  return { data: r, human, code: r.code };
});

register("hook", async (a) => {
  try {
    await runHookCli(a._[1] ?? "", str(a, "harness"), str(a, "root"));
  } catch (e: any) {
    process.stderr.write(`tcheck hook: ${e?.message ?? e}\n`); // hooks never break the session
  }
  return { data: undefined, code: 0 };
});

register("mcp", async () => {
  await serve();
  return { data: undefined };
});

register("run start", (a) => {
  const r = runStart(repoOf(a), { mode: str(a, "mode") ?? "", buggy: str(a, "buggy"), fixed: str(a, "fixed"), existing: list(a, "existing") });
  return { data: { run: r.id, mode: r.mode, revisions: r.revisions }, human: r.id };
});

register("target add", (a) => {
  const t = targetAdd(repoOf(a), need(a, 1, "run"), need(a, 2, "file::symbol"), str(a, "lines") ?? "", str(a, "rev"));
  return { data: { target: t.id, file: t.file, symbol: t.symbol, lines: t.lines, rev: t.rev, body_sha: t.body_sha }, human: t.id };
});

register("context set", (a) => {
  const r = contextSet(repoOf(a), need(a, 1, "run"), need(a, 2, "target"), str(a, "file") ?? need(a, 3, "--file"));
  return { data: r, human: `Context saved for ${r.target}. Leak check: passed.` };
});

register("spec prompt", (a) => {
  const p = specPrompt(repoOf(a), need(a, 1, "run"), need(a, 2, "target"), str(a, "intent"));
  return { data: { payload: p.id, text: p.full }, human: p.full };
});

register("spec save", (a) => {
  const from = str(a, "from");
  if (!from) throw usage("spec save needs --from FILE (or - for stdin)");
  const r = specSave(repoOf(a), need(a, 1, "run"), need(a, 2, "target"), readInput(from));
  return { data: r, human: `Spec saved for ${r.target}. Leak check: passed.` };
});

register("spec show", (a) => {
  const r = specShow(repoOf(a), need(a, 1, "run"), need(a, 2, "target"));
  return { data: r, human: r.spec + (r.analysis ? `\n\n--- spec-extractor suspicions ---\n${r.analysis}` : "") };
});

register("spec edit", (a) => {
  const from = str(a, "from");
  if (!from) throw usage("spec edit needs --from FILE (or - for stdin)");
  const r = specEdit(repoOf(a), need(a, 1, "run"), need(a, 2, "target"), readInput(from));
  return { data: r, human: `Spec updated for ${r.target}. ${r.note}` };
});

register("bundle build", (a) => {
  const r = bundleBuild(repoOf(a), need(a, 1, "run"), need(a, 2, "target"));
  return { data: r, human: r.bundle };
});

register("bundle emit", (a) => {
  const via = str(a, "via");
  if (via && via !== "tool" && via !== "text") throw usage("--via must be tool or text");
  const r = bundleEmit(repoOf(a), need(a, 1, "bundle"), (str(a, "role") ?? "") as any, { run: str(a, "run"), via: via as any });
  // The payload is printed exactly; the agent passes it verbatim to the blind role.
  return { data: { payload: r.payload, target: r.target, round: r.round, text: r.full }, human: r.full };
});

register("ingest", (a) => {
  const from = str(a, "from");
  if (!from) throw usage("ingest needs --from FILE (or - for stdin)");
  const r = ingest(repoOf(a), need(a, 1, "payload"), readInput(from));
  return { data: r, human: r.message };
});

register("compose", (a) => {
  const r = compose(repoOf(a), need(a, 1, "run"));
  const human = [`Composed ${r.files.length} file(s):`, ...r.files.map((f) => `  ${f.path}  (${f.target}, round ${f.round})`), ...(r.missing.length ? [`No tests yet for: ${r.missing.join(", ")}`] : [])].join("\n");
  return { data: r, human };
});

register("exec", async (a) => {
  const r = await execRun(repoOf(a), need(a, 1, "run"), { log: bool(a, "quiet") || bool(a, "json") ? () => {} : undefined });
  const human = Object.entries(r.targets)
    .map(([t, s]) => `${t}: ${s.status}${s.count ? ` (${s.count})` : ""}`)
    .concat(r.setup_error ? [`setup failed:\n${r.setup_error}`] : [])
    .join("\n");
  return { data: r, human, code: r.code };
});

register("adjudicate queue", (a) => {
  const q = queue(repoOf(a), need(a, 1, "run"));
  return { data: q, human: q.length ? q.map((x) => `${x.status === "pending" ? "pending " : `${x.verdict}`.padEnd(8)} ${x.test}\n         ${x.category}: ${x.reason}`).join("\n") : "Nothing queued." };
});

register("adjudicate prompt", (a) => {
  const p = adjudicatePrompt(repoOf(a), need(a, 1, "run"), need(a, 2, "test"));
  return { data: { payload: p.id, text: p.full }, human: p.full };
});

register("adjudicate save", (a) => {
  const from = str(a, "from");
  if (!from) throw usage("adjudicate save needs --from FILE (or - for stdin)");
  const r = adjudicateSave(repoOf(a), need(a, 1, "run"), need(a, 2, "test"), readInput(from));
  return { data: r, human: r.message };
});

register("adjudicate override", (a) => {
  const r = adjudicateOverride(repoOf(a), need(a, 1, "run"), need(a, 2, "test"), str(a, "verdict") ?? "", str(a, "reason") ?? "");
  return { data: r, human: r.message };
});

register("report", (a) => {
  const r = report(repoOf(a), need(a, 1, "run"), { harness: str(a, "harness") });
  return { data: r.report, human: r.summary };
});

register("promote", (a) => {
  const r = promote(repoOf(a), need(a, 1, "run"), { tests: list(a, "tests"), allAccepted: bool(a, "all-accepted"), force: bool(a, "force") });
  const human = [
    r.promoted.length ? `Promoted ${r.promoted.length} file(s):` : "Nothing promoted.",
    ...r.promoted.map((f) => `  ${f.dest}`),
    ...r.skipped.map((s) => `  skipped ${s.file}: ${s.reason}`),
    ...(r.verified.length ? [`Marked verified: ${r.verified.join(", ")}`] : []),
  ].join("\n");
  return { data: r, human };
});

register("classify", (a) => {
  const c = classify(repoOf(a), need(a, 1, "run"));
  const human = [
    ...Object.entries(c.counts).map(([t, cs]) => `${t}: ${Object.entries(cs).map(([k, v]) => `${k} ${v}`).join(", ")}`),
    `${c.queue.length} test(s) queued for adjudication.`,
  ].join("\n");
  return { data: c, human };
});

