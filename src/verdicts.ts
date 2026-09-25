import * as fs from "node:fs";
import { Repo } from "./repo";
import { ERRORS_LABEL, listRuns, loadRun, runDir } from "./run";
import { readJson, writeJson } from "./util";
import type { Results } from "./exec";

export type VerdictKind = "code-wrong" | "test-wrong" | "spec-ambiguous";
export const VERDICTS: VerdictKind[] = ["code-wrong", "test-wrong", "spec-ambiguous"];

export interface Verdict {
  verdict: VerdictKind;
  spec_basis: string;
  reason: string;
  source: "model" | "user";
  at: string;
  warning?: string;
}

export type VerdictFile = Record<string, { model?: Verdict; override?: Verdict }>;

export function loadVerdicts(repo: Repo, runId: string): VerdictFile {
  return readJson(runDir(repo, runId, "verdicts.json"), {});
}

export function saveVerdicts(repo: Repo, runId: string, v: VerdictFile): void {
  writeJson(runDir(repo, runId, "verdicts.json"), v);
}

/** The user's override takes precedence over the model verdict (engine-spec §5). */
export function effective(e: { model?: Verdict; override?: Verdict } | undefined): Verdict | undefined {
  return e?.override ?? e?.model;
}

export interface Unresolved {
  run: string;
  test: string;
  target: string;
  verdict: VerdictKind;
  reason: string;
  spec_basis: string;
}

/**
 * Verdicts that block promote (engine-spec §8.5):
 * code-wrong until an exec after the verdict shows the test passing on the fixed/current revision;
 * spec-ambiguous until a user override, or a spec edit followed by regenerated tests.
 */
export function unresolved(repo: Repo, runId: string): Unresolved[] {
  const run = loadRun(repo, runId);
  const verdicts = loadVerdicts(repo, runId);
  const resultsFile = runDir(repo, runId, "results.json");
  const results: Results | null = fs.existsSync(resultsFile) ? readJson(resultsFile) : null;
  const ledger = repo.readLedger().filter((e) => e.run === runId);
  const out: Unresolved[] = [];
  for (const [test, entry] of Object.entries(verdicts)) {
    const v = effective(entry);
    if (!v || v.verdict === "test-wrong") continue;
    const target = test.split("::")[0];
    if (v.verdict === "code-wrong") {
      const lr = results?.labels[ERRORS_LABEL[run.mode]];
      const fixedNow = results && results.at > v.at && lr?.tests[test]?.final === "pass";
      if (fixedNow) continue;
    } else {
      if (entry.override) continue;
      const edit = ledger.find((e) => e.type === "spec_edited" && e.target === target && e.ts > v.at);
      if (edit && ledger.some((e) => e.type === "tests_submitted" && e.target === target && e.ts > edit.ts)) continue;
    }
    out.push({ run: runId, test, target, verdict: v.verdict, reason: v.reason, spec_basis: v.spec_basis });
  }
  return out;
}

export function openRuns(repo: Repo): string[] {
  return listRuns(repo)
    .filter((r) => r.status === "open")
    .map((r) => r.id);
}
