// Registers every command beyond the setup basics in cli.ts.
import { register, str, list, bool, Args } from "./cli";
import { Repo } from "./repo";
import { runStart, targetAdd, compose } from "./run";
import { execRun } from "./exec";
import { classify } from "./classify";
import { readInput, usage } from "./util";
import { contextSet, specEdit, specPrompt, specSave, specShow } from "./spec";
import { bundleBuild, bundleEmit, ingest } from "./bundle";

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

register("classify", (a) => {
  const c = classify(repoOf(a), need(a, 1, "run"));
  const human = [
    ...Object.entries(c.counts).map(([t, cs]) => `${t}: ${Object.entries(cs).map(([k, v]) => `${k} ${v}`).join(", ")}`),
    `${c.queue.length} test(s) queued for adjudication.`,
  ].join("\n");
  return { data: c, human };
});

