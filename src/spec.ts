import * as fs from "node:fs";
import * as path from "node:path";
import { Repo, pluginRoot } from "./repo";
import { LeakOpts, LeakTarget, checkLeak, commonLines, formatFindings } from "./leak";
import { Target, expandPath, loadRun, loadTarget, runDir } from "./run";
import { renderPrompt, storePayload } from "./payload";
import { validate } from "./schema";
import { readJson, rejected, usage, writeJson, writeText } from "./util";

/** Leak-check inputs for a run: every target body, the repo's common lines, config thresholds. */
export function leakContext(repo: Repo, runId: string): { targets: LeakTarget[]; opts: LeakOpts } {
  const run = loadRun(repo, runId);
  return {
    targets: run.targets.map((t) => loadTarget(repo, runId, t)),
    opts: { common: commonLines(repo, runId), minLen: repo.config.leak.min_line_length, threshold: repo.config.leak.shingle_threshold },
  };
}

export function assertNoLeak(repo: Repo, runId: string, text: string, where: string, advice: string): { shingle_ratio: number } {
  const { targets, opts } = leakContext(repo, runId);
  const r = checkLeak(text, targets, opts);
  if (!r.passed) throw rejected(`leak check failed for ${where}:\n${formatFindings(r, where)}\n${advice}`, r);
  return { shingle_ratio: r.shingle_ratio };
}

// ---------------- context ----------------

let bundleSchemaCache: any;
export function bundleSchema(): any {
  bundleSchemaCache ??= readJson(path.join(pluginRoot(), "skills", "verify-tests", "references", "bundle.schema.json"));
  return bundleSchemaCache;
}

/** Every string in a JSON value, one per line — what the leak check reads. */
export function jsonStrings(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(jsonStrings).join("\n");
  if (v && typeof v === "object") return Object.values(v).map(jsonStrings).join("\n");
  return "";
}

export function contextSet(repo: Repo, runId: string, targetId: string, file: string) {
  loadTarget(repo, runId, targetId);
  let ctx: any;
  try {
    ctx = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    throw rejected(`${file} is not valid JSON: ${e.message}`);
  }
  const errs = validate(bundleSchema().properties.context, ctx, "context");
  if (errs.length) throw rejected(`context does not match bundle.schema.json:\n  ${errs.join("\n  ")}`, errs);
  const leak = assertNoLeak(repo, runId, jsonStrings(ctx), "context", "Context must hold signatures only, never lines from the target body.");
  writeJson(runDir(repo, runId, "targets", targetId, "context.json"), ctx);
  repo.ledger("context_set", { run: runId, target: targetId, shingle_ratio: leak.shingle_ratio });
  return { target: targetId, leak_check: "passed" };
}

export function loadContext(repo: Repo, runId: string, targetId: string): any {
  return readJson(runDir(repo, runId, "targets", targetId, "context.json"), {});
}

const fence = (tag: string, lines: string[]) => "```" + tag + "\n" + lines.join("\n") + "\n```";

/** context.json as readable markdown, signatures in code fences (prompts/README.md). */
export function contextMarkdown(ctx: any, tag: string, opts: { forWriter?: boolean } = {}): string {
  const out: string[] = [];
  const et = ctx.enclosing_type;
  if (et) {
    out.push(`### Enclosing type \`${et.name ?? "?"}\``);
    if (et.constructors?.length) out.push("Constructors:", fence(tag, et.constructors));
    if (et.fields?.length) out.push("Fields:", fence(tag, et.fields));
    if (et.sibling_signatures?.length) out.push("Other methods:", fence(tag, et.sibling_signatures));
  }
  for (const t of ctx.types ?? []) {
    out.push(`### Type \`${t.name}\`${t.file ? ` (${t.file})` : ""}`);
    if (t.constructors?.length) out.push("Constructors:", fence(tag, t.constructors));
    if (t.public_signatures?.length) out.push("Public members:", fence(tag, t.public_signatures));
  }
  if (ctx.module_signatures?.length) out.push("### Other functions in the module", fence(tag, ctx.module_signatures));
  const tc = ctx.test_conventions ?? {};
  // The writer template shows imports and the example test itself.
  if (!opts.forWriter && tc.imports?.length) out.push("### Test imports", fence(tag, tc.imports));
  if (tc.fixtures?.length) out.push("### Available fixtures and helpers", tc.fixtures.map((f: string) => `- ${f}`).join("\n"));
  return out.length ? out.join("\n\n") : "(none provided)";
}

// ---------------- spec ----------------

export function variantFor(repo: Repo): string {
  const v = repo.config.spec.variant;
  // auto: the harness models are all reasoning models; `scaffold` is for base models (paper §8.1).
  return v === "auto" ? "reasoning" : v;
}

export function configVars(repo: Repo, t: { id: string; file: string; symbol: string }) {
  const c = repo.config;
  return { language: c.language, language_tag: c.language_tag, framework: c.framework, test_file_pattern: expandPath(c.test_file_pattern, t) };
}

export function specPrompt(repo: Repo, runId: string, targetId: string, intent?: string) {
  const t = loadTarget(repo, runId, targetId);
  const vars = {
    ...configVars(repo, t),
    target: { symbol: t.symbol, file: t.file, body: t.body },
    context_markdown: contextMarkdown(loadContext(repo, runId, targetId), repo.config.language_tag),
    intent_hint: intent ?? "",
  };
  const body = renderPrompt(`spec-extract.${repo.config.spec.prompt}.md`, vars, "spec", variantFor(repo));
  return storePayload(repo, { role: "spec", run: runId, target: targetId }, body);
}

const tag = (text: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(text);
  return m ? m[1].trim() : null;
};

/** Parse spec-extractor output: <analysis> and <spec>, or Part 3 of the scaffold variant. */
export function parseSpecOutput(raw: string): { spec: string; analysis: string } {
  let spec = tag(raw, "spec");
  const analysis = tag(raw, "analysis") ?? "";
  if (!spec) {
    const m = /Part\s*3[^\n]*\n([\s\S]+)$/i.exec(raw);
    spec = m ? m[1].trim() : null;
  }
  if (!spec) throw rejected("no <spec> block found in the spec-extractor output. Ask the role to answer in the required format and save again.");
  return { spec, analysis };
}

export function specSave(repo: Repo, runId: string, targetId: string, raw: string) {
  loadTarget(repo, runId, targetId);
  const { spec, analysis } = parseSpecOutput(raw);
  const leak = assertNoLeak(repo, runId, spec, "spec", "The spec quotes the implementation. Re-run the spec extractor, or fix it with `tcheck spec edit`.");
  const dir = runDir(repo, runId, "targets", targetId);
  writeText(path.join(dir, "spec.raw.md"), raw);
  writeText(path.join(dir, "spec.md"), spec + "\n");
  writeText(path.join(dir, "analysis.md"), analysis ? analysis + "\n" : "");
  repo.ledger("spec_saved", { run: runId, target: targetId, shingle_ratio: leak.shingle_ratio });
  return { target: targetId, spec, analysis, leak_check: "passed" };
}

export function specShow(repo: Repo, runId: string, targetId: string) {
  const dir = runDir(repo, runId, "targets", targetId);
  if (!fs.existsSync(path.join(dir, "spec.md"))) throw usage(`no spec saved for ${targetId}; run \`tcheck spec prompt ${runId} ${targetId}\` first`);
  return { target: targetId, spec: fs.readFileSync(path.join(dir, "spec.md"), "utf8").trim(), analysis: fs.existsSync(path.join(dir, "analysis.md")) ? fs.readFileSync(path.join(dir, "analysis.md"), "utf8").trim() : "" };
}

export function specEdit(repo: Repo, runId: string, targetId: string, text: string) {
  loadTarget(repo, runId, targetId);
  const spec = (tag(text, "spec") ?? text).trim();
  if (!spec) throw rejected("the new spec is empty");
  assertNoLeak(repo, runId, spec, "spec", "The edited spec quotes the implementation.");
  writeText(runDir(repo, runId, "targets", targetId, "spec.md"), spec + "\n");
  repo.ledger("spec_edited", { run: runId, target: targetId });
  return { target: targetId, spec, note: "Existing bundles for this target are now stale; run `tcheck bundle build` again." };
}

export function loadSpec(repo: Repo, runId: string, targetId: string): string | null {
  const f = runDir(repo, runId, "targets", targetId, "spec.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
}

export type { Target };
