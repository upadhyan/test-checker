import * as fs from "node:fs";
import * as path from "node:path";
import { Repo } from "./repo";
import { Backend, firstHeadless } from "./env";
import { buildFixtureRepo, listFixtures } from "./fixtures";
import { runStart, targetAdd, compose, loadTarget } from "./run";
import { execRun } from "./exec";
import { classify } from "./classify";
import { contextMarkdown, contextSet, configVars, leakContext, specPrompt, specSave } from "./spec";
import { bundleBuild, ingest } from "./bundle";
import { blindRun, backendOpts, runBackend } from "./backends";
import { renderPrompt, storePayload, payloadIndex } from "./payload";
import { checkLeak } from "./leak";
import { EXIT, TcheckError, envMissing, listFilesRecursive } from "./util";

type Counts = { effective: number; misguided: number; broken: number; neutral: number };
const ZERO = (): Counts => ({ effective: 0, misguided: 0, broken: 0, neutral: 0 });

interface FixtureResult {
  fixture: string;
  blind: Counts | null;
  baseline: Counts | null;
  errors: string[];
  repair_rounds: number;
  min_effective: number;
  leak_clean: boolean;
  dir: string;
}

function counts(cls: { tests: { category: string }[] }): Counts {
  const c = ZERO();
  for (const t of cls.tests) if (t.category in c) c[t.category as keyof Counts]++;
  return c;
}

async function blindPipeline(repo: Repo, fx: ReturnType<typeof buildFixtureRepo>, backend: Backend, log: (s: string) => void, res: FixtureResult, withIntent = false) {
  const run = runStart(repo, { mode: "bugfix", buggy: fx.buggy, fixed: fx.fixed }).id;
  const t = targetAdd(repo, run, fx.fixture.target, fx.fixture.lines.join("-"));
  contextSet(repo, run, t.id, path.join(fx.fixture.dir, "context.json"));
  const opts = backendOpts(repo);
  // Spec: one retry if the output quotes the body or misses the format.
  for (let attempt = 1; ; attempt++) {
    const p = specPrompt(repo, run, t.id, withIntent ? fx.fixture.intent : undefined);
    log(`${fx.fixture.name}: spec (attempt ${attempt})`);
    const out = await runBackend(backend, p.full, opts);
    try {
      specSave(repo, run, t.id, out);
      break;
    } catch (e: any) {
      if (attempt >= 2) throw e;
      log(`${fx.fixture.name}: spec rejected (${e.message.split("\n")[0]}), retrying`);
    }
  }
  const { bundle } = bundleBuild(repo, run, t.id);
  log(`${fx.fixture.name}: blind writer`);
  await blindRun(repo, bundle, "writer", { run, backend });
  compose(repo, run);
  let ex = await execRun(repo, run, { log: () => {} });
  while (ex.targets[t.id]?.status === "needs_repair" && res.repair_rounds < repo.config.refine_rounds) {
    res.repair_rounds++;
    log(`${fx.fixture.name}: repair round ${res.repair_rounds}`);
    await blindRun(repo, bundle, "repair", { run, backend });
    compose(repo, run);
    ex = await execRun(repo, run, { log: () => {} });
  }
  if (ex.targets[t.id]?.status === "failed_setup") throw new TcheckError(`setup failed: ${ex.setup_error}`, EXIT.COMMAND);
  return { run, cls: classify(repo, run) };
}

async function baselinePipeline(repo: Repo, fx: ReturnType<typeof buildFixtureRepo>, backend: Backend, log: (s: string) => void) {
  const run = runStart(repo, { mode: "bugfix", buggy: fx.buggy, fixed: fx.fixed }).id;
  const t = targetAdd(repo, run, fx.fixture.target, fx.fixture.lines.join("-"));
  contextSet(repo, run, t.id, path.join(fx.fixture.dir, "context.json"));
  const tt = loadTarget(repo, run, t.id);
  const ctx = JSON.parse(fs.readFileSync(path.join(fx.fixture.dir, "context.json"), "utf8"));
  // The paper's code-based setting: the model sees the (buggy) implementation.
  const body = renderPrompt("code-aware-baseline.md", { ...configVars(repo, tt), target: { symbol: tt.symbol, file: tt.file, body: tt.body }, context_markdown: contextMarkdown(ctx, repo.config.language_tag) }, "baseline");
  const p = storePayload(repo, { role: "baseline", run, target: t.id }, body);
  log(`${fx.fixture.name}: baseline writer`);
  ingest(repo, p.id, await runBackend(backend, p.full, backendOpts(repo)));
  compose(repo, run);
  await execRun(repo, run, { log: () => {} });
  return { run, cls: classify(repo, run) };
}

/** Criterion 4: no frozen bundle or blind payload contains a significant body line. */
function leakClean(repo: Repo, blindRunId: string): boolean {
  const { targets, opts } = leakContext(repo, blindRunId);
  const idx = payloadIndex(repo);
  const files = [
    ...listFilesRecursive(repo.p("bundles")).filter((f) => f.includes(`-${blindRunId.slice(-4)}-`)),
    ...Object.values(idx)
      .filter((e) => e.run === blindRunId && (e.role === "writer" || e.role === "repair"))
      .map((e) => repo.p("payloads", `${e.id}.md`)),
  ];
  return files.every((f) => checkLeak(fs.readFileSync(f, "utf8"), targets, { ...opts, threshold: 1 }).findings.length === 0);
}

export async function selftest(opts: { backend?: string; fixtures?: string[]; withIntent?: boolean; log?: (s: string) => void }) {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const backend = (opts.backend ?? firstHeadless()) as Backend | null;
  if (!backend) throw envMissing("selftest needs a headless backend: install claude, codex, opencode or pi, or pass --backend api");
  const names = opts.fixtures?.length ? opts.fixtures : listFixtures();
  if (!names.length) throw envMissing("no fixtures found");
  log(`selftest: ${names.length} fixture(s) via ${backend}${opts.withIntent ? " (with fixture intent)" : " (paper setting: no stated intent)"}`);

  const results = await Promise.all(
    names.map(async (name): Promise<FixtureResult> => {
      const fx = buildFixtureRepo(name);
      const repo = new Repo(fx.dir);
      const res: FixtureResult = { fixture: name, blind: null, baseline: null, errors: [], repair_rounds: 0, min_effective: fx.fixture.expect?.min_effective_blind ?? 1, leak_clean: true, dir: fx.dir };
      // Sequential per fixture: both runs share the repo's cached worktrees. Fixtures run in parallel.
      const settle = <T>(p: Promise<T>) => p.then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
      const b = await settle(blindPipeline(repo, fx, backend, log, res, opts.withIntent));
      const base = await settle(baselinePipeline(repo, fx, backend, log));
      if (b.status === "fulfilled") {
        res.blind = counts(b.value.cls);
        res.leak_clean = leakClean(repo, b.value.run);
      } else res.errors.push(`blind: ${b.reason?.message ?? b.reason}`);
      if (base.status === "fulfilled") res.baseline = counts(base.value.cls);
      else res.errors.push(`baseline: ${base.reason?.message ?? base.reason}`);
      log(`${name}: done${res.errors.length ? ` with errors: ${res.errors.join("; ")}` : ""}`);
      return res;
    }),
  );

  const perFixture = results.map((r) => ({
    fixture: r.fixture,
    c1_pipeline: !!r.blind && !r.errors.some((e) => e.startsWith("blind")),
    c2_effective: (r.blind?.effective ?? 0) >= r.min_effective,
  }));
  const sum = (k: keyof Counts, side: "blind" | "baseline") => results.reduce((n, r) => n + (r[side]?.[k] ?? 0), 0);
  const c3 = sum("misguided", "blind") < sum("misguided", "baseline");
  const c4 = results.every((r) => r.leak_clean);
  const hardPass = perFixture.every((p) => p.c1_pipeline && p.c2_effective) && c4;

  const row = (r: FixtureResult, side: "blind" | "baseline") => {
    const c = r[side];
    return `${r.fixture.padEnd(15)} ${side.padEnd(9)} ${c ? [c.effective, c.misguided, c.broken, c.neutral].map((n) => String(n).padStart(9)).join("") : "    (failed)"}`;
  };
  const table = [
    `${"fixture".padEnd(15)} ${"side".padEnd(9)}${["effective", "misguided", "broken", "neutral"].map((h) => h.padStart(10)).join("")}`,
    ...results.flatMap((r) => [row(r, "blind"), row(r, "baseline")]),
    `${"TOTAL".padEnd(15)} ${"blind".padEnd(9)}${(["effective", "misguided", "broken", "neutral"] as const).map((k) => String(sum(k, "blind")).padStart(10)).join("")}`,
    `${"TOTAL".padEnd(15)} ${"baseline".padEnd(9)}${(["effective", "misguided", "broken", "neutral"] as const).map((k) => String(sum(k, "baseline")).padStart(10)).join("")}`,
    "",
    ...perFixture.map((p) => `${p.fixture}: 1 pipeline ${p.c1_pipeline ? "PASS" : "FAIL"}, 2 effective ≥ min ${p.c2_effective ? "PASS" : "FAIL"}`),
    `3 blind misguided < baseline misguided: ${c3 ? "PASS" : "WARN"} (${sum("misguided", "blind")} vs ${sum("misguided", "baseline")})`,
    `4 no body lines in bundles/payloads: ${c4 ? "PASS" : "FAIL"}`,
    ...results.filter((r) => r.errors.length).map((r) => `errors in ${r.fixture}: ${r.errors.join("; ")}`),
    `selftest: ${hardPass ? "PASS" : "FAIL"}${hardPass && !c3 ? " (criterion 3 warns)" : ""}`,
  ].join("\n");
  return { backend, results, criteria: { per_fixture: perFixture, c3_fewer_misguided: c3, c4_no_leaks: c4 }, pass: hardPass, table, code: hardPass ? EXIT.OK : EXIT.REJECTED };
}
