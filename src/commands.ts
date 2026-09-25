// Registers every command beyond the setup basics in cli.ts.
import { register, str, list, bool, Args } from "./cli";
import { Repo } from "./repo";
import { runStart, targetAdd, compose } from "./run";
import { execRun } from "./exec";
import { classify } from "./classify";
import { usage } from "./util";

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

