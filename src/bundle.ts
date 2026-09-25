import * as fs from "node:fs";
import * as path from "node:path";
import { Repo } from "./repo";
import { checkFileName, isRoundMeta, generatedDir, latestRound, loadRun, loadTarget, runDir } from "./run";
import { assertNoLeak, bundleSchema, configVars, contextMarkdown, jsonStrings, leakContext, loadContext, loadSpec } from "./spec";
import { Role, consumePayload, loadPayload, newPayloadId, renderPrompt, requireRole, storePayload } from "./payload";
import { redactRepairText } from "./repair";
import { validate } from "./schema";
import { listFilesRecursive, nowIso, readJson, rejected, usage, writeJson, writeText } from "./util";
import type { Repairable } from "./exec";

export function bundleId(runId: string, targetId: string): string {
  return `b-${runId.slice(-4)}-${targetId}`;
}

export function loadBundle(repo: Repo, id: string): any {
  const f = repo.p("bundles", `${id}.json`);
  if (!fs.existsSync(f)) throw usage(`unknown bundle: ${id}`);
  return readJson(f);
}

/** engine-spec §5 `bundle build`: focal + spec + context + meta, schema- and leak-checked, frozen. */
export function bundleBuild(repo: Repo, runId: string, targetId: string) {
  const t = loadTarget(repo, runId, targetId);
  const spec = loadSpec(repo, runId, targetId);
  if (!spec) throw usage(`no spec for ${targetId}; save one with \`tcheck spec save\` first`);
  const context = loadContext(repo, runId, targetId);
  const id = bundleId(runId, targetId);
  const focal = { name: t.symbol, signature: t.signature.trim(), file: t.file, language: repo.config.language };
  const leak = assertNoLeak(repo, runId, jsonStrings({ spec, context }), "bundle", "Fix the spec or context, then build again.");
  const bundle = {
    focal,
    spec,
    context,
    meta: { bundle_id: id, run_id: runId, target_id: targetId, created_at: nowIso(), leak_check: { passed: true, method: "line+shingle (engine-spec §6)", max_shared_line_ratio: leak.shingle_ratio } },
  };
  const errs = validate(bundleSchema(), bundle, "bundle");
  if (errs.length) throw rejected(`bundle does not match bundle.schema.json:\n  ${errs.join("\n  ")}`, errs);
  writeJson(repo.p("bundles", `${id}.json`), bundle);
  repo.ledger("bundle_frozen", { run: runId, target: targetId, bundle: id });
  return { bundle: id };
}

/** Test files of a target's latest round, as markdown for the repair prompt. */
function previousTestsMarkdown(repo: Repo, runId: string, targetId: string, tag: string): string {
  const round = latestRound(repo, runId, targetId);
  if (round === null) return "(none)";
  return listFilesRecursive(generatedDir(repo, runId, targetId, round))
    .filter((f) => !isRoundMeta(path.basename(f)))
    .map((f) => `FILE: ${path.basename(f)}\n\`\`\`${tag}\n${fs.readFileSync(f, "utf8").trimEnd()}\n\`\`\``)
    .join("\n\n");
}

/** Consecutive repair rounds on top of the latest writer round. */
export function repairRoundsSoFar(repo: Repo, runId: string, targetId: string): number {
  let n = 0;
  for (let r = latestRound(repo, runId, targetId); r !== null && r >= 0; r--) {
    const meta = readJson<{ role?: string }>(path.join(generatedDir(repo, runId, targetId, r), "round.json"), {});
    if (meta.role !== "repair") break;
    n++;
  }
  return n;
}

/** Filtered, redacted errors for repair (engine-spec §8.4): grouped by file, 4 KB each. */
export function filteredErrors(repo: Repo, runId: string, targetId: string): string {
  const rep = readJson<{ targets: Record<string, Repairable[]> }>(runDir(repo, runId, "repairable.json"), { targets: {} });
  const items = rep.targets[targetId] ?? [];
  if (!items.length) return "";
  const { targets, opts } = leakContext(repo, runId);
  const groups = new Map<string, string[]>();
  for (const i of items) {
    const key = i.kind === "compile" ? "(compile step)" : i.file ? path.basename(i.file) : "(run)";
    const text = i.kind === "error" && i.test ? `${i.test}: ${i.text}` : i.text;
    groups.set(key, [...(groups.get(key) ?? []), text]);
  }
  return [...groups.entries()].map(([file, texts]) => `== ${file} ==\n${redactRepairText([...new Set(texts)].join("\n"), targets, opts)}`).join("\n\n");
}

export type Consumer = "tool" | "text";

/** Render + freeze a writer or repair payload (engine-spec §7). */
export function bundleEmit(repo: Repo, id: string, role: Role, opts: { run?: string; via?: Consumer } = {}) {
  if (role !== "writer" && role !== "repair") throw usage("--role must be writer or repair");
  const bundle = loadBundle(repo, id);
  const runId = opts.run ?? bundle.meta.run_id;
  if (runId !== bundle.meta.run_id) throw usage(`bundle ${id} belongs to run ${bundle.meta.run_id}, not ${runId}`);
  const targetId = bundle.meta.target_id;
  const t = loadTarget(repo, runId, targetId);
  if (loadSpec(repo, runId, targetId) !== bundle.spec) throw rejected(`bundle ${id} is stale: the spec was edited since it was built. Run \`tcheck bundle build ${runId} ${targetId}\`.`);
  const cfg = repo.config;
  const payloadId = newPayloadId();
  const via = opts.via ?? "tool";
  const vars: Record<string, any> = {
    ...configVars(repo, t),
    bundle,
    bundle_context_markdown: contextMarkdown(bundle.context, cfg.language_tag, { forWriter: true }),
    payload_id: payloadId,
    submit_via_tool: via === "tool" ? "yes" : "",
    submit_via_text: via === "text" ? "yes" : "",
  };
  let round = (latestRound(repo, runId, targetId) ?? -1) + 1;
  if (role === "repair") {
    if (latestRound(repo, runId, targetId) === null) throw usage(`no tests submitted for ${targetId} yet; emit a writer payload first`);
    const done = repairRoundsSoFar(repo, runId, targetId);
    if (done >= cfg.refine_rounds) throw rejected(`${targetId} already had ${done} repair round(s) (refine_rounds: ${cfg.refine_rounds}). Remaining broken tests are dropped.`);
    const errors = filteredErrors(repo, runId, targetId);
    if (!errors) throw rejected(`the latest exec has no repairable errors for ${targetId}; nothing to repair`);
    Object.assign(vars, { previous_tests_markdown: previousTestsMarkdown(repo, runId, targetId, cfg.language_tag), filtered_errors: errors, round: done + 1, max_rounds: cfg.refine_rounds });
  }
  const body = renderPrompt(role === "writer" ? "blind-write.md" : "repair.md", vars, role);
  assertNoLeak(repo, runId, body, `${role} payload`, "Refusing to emit a blind payload that contains the implementation.");
  if (role === "repair") round = latestRound(repo, runId, targetId)! + 1;
  const { full } = storePayload(repo, { id: payloadId, role, run: runId, target: targetId, bundle: id, round }, body);
  return { payload: payloadId, full, target: targetId, round };
}

export interface SubmittedFile {
  path: string;
  content: string;
}

export const MAX_FILES = 20;
export const MAX_BYTES = 200 * 1024;

/** Shared by the MCP `submit_tests` tool and `ingest` (engine-spec §9). */
export function submitTests(repo: Repo, payloadId: string, files: SubmittedFile[], notes?: string): { message: string; target: string; round: number; files: string[] } {
  const { entry } = loadPayload(repo, payloadId);
  requireRole(entry, ["writer", "repair", "baseline"]);
  if (entry.consumed) throw rejected(`payload ${payloadId} was already used; emit a new one`);
  const targetId = entry.target!;
  const t = loadTarget(repo, entry.run, targetId);
  if (!Array.isArray(files) || !files.length) throw rejected("no files submitted");
  if (files.length > MAX_FILES) throw rejected(`too many files (${files.length} > ${MAX_FILES})`);
  const total = files.reduce((n, f) => n + Buffer.byteLength(String(f.content ?? "")), 0);
  if (total > MAX_BYTES) throw rejected(`files total ${total} bytes (> ${MAX_BYTES})`);
  const problems = files.flatMap((f) => {
    const p = checkFileName(String(f.path ?? ""), repo.config.test_file_pattern, t);
    return p ? [p] : typeof f.content !== "string" || !f.content.trim() ? [`"${f.path}" is empty`] : [];
  });
  if (new Set(files.map((f) => f.path)).size !== files.length) problems.push("duplicate file names");
  if (problems.length) throw rejected(`submission rejected:\n  ${problems.join("\n  ")}`);

  consumePayload(repo, payloadId); // single use: first successful submission wins
  const prev = latestRound(repo, entry.run, targetId);
  const round = prev === null ? 0 : prev + 1;
  const dir = generatedDir(repo, entry.run, targetId, round);
  fs.mkdirSync(dir, { recursive: true });
  // A repair round carries over files the repair role did not resubmit.
  if (entry.role === "repair" && prev !== null) {
    for (const f of listFilesRecursive(generatedDir(repo, entry.run, targetId, prev))) {
      const name = path.basename(f);
      if (!isRoundMeta(name) && !files.some((s) => s.path === name)) fs.copyFileSync(f, path.join(dir, name));
    }
  }
  for (const f of files) writeText(path.join(dir, f.path), f.content.endsWith("\n") ? f.content : f.content + "\n");
  if (notes?.trim()) writeText(path.join(dir, "notes.md"), notes.trim() + "\n");
  writeJson(path.join(dir, "round.json"), { role: entry.role, payload: payloadId, at: nowIso() });
  repo.ledger("tests_submitted", { run: entry.run, target: targetId, round, role: entry.role, payload: payloadId, files: files.map((f) => f.path) });
  return { message: `Stored ${files.length} test file${files.length === 1 ? "" : "s"} for ${targetId} (round ${round}).`, target: targetId, round, files: files.map((f) => f.path) };
}

/** Parse `FILE: name` + fenced block pairs and an optional `NOTES:` section from text output. */
export function parseTextSubmission(text: string): { files: SubmittedFile[]; notes: string } {
  const files: SubmittedFile[] = [];
  const re = /^[ \t>*_#-]*FILE:\s*[`*"]*([^\s`*"]+)[`*"]*\s*\n+(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2[ \t]*$/gm;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    files.push({ path: m[1].trim(), content: m[3] + "\n" });
    last = re.lastIndex;
  }
  const nm = /^[ \t*_#]*NOTES:?[*_]*[ \t]*\n?([\s\S]*)$/m.exec(text.slice(last));
  return { files, notes: nm ? nm[1].trim() : "" };
}

export function ingest(repo: Repo, payloadId: string, text: string) {
  const { files, notes } = parseTextSubmission(text);
  if (!files.length) throw rejected("no `FILE: <name>` + fenced code blocks found in the output");
  return submitTests(repo, payloadId, files, notes);
}

export { loadRun };
