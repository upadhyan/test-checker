import * as fs from "node:fs";
import * as path from "node:path";
import { Repo, STATE_DIR, findRoot } from "./repo";
import { dirtyFiles } from "./dirty";
import { loadPayload, parseFrame } from "./payload";
import { globToRegex, matchGlobs, nowIso, toPosix } from "./util";
import { detectHarness } from "./env";

export type HookEvent = "session-start" | "handoff-guard" | "protect-tests" | "stop-gate";
export const HOOK_EVENTS: HookEvent[] = ["session-start", "handoff-guard", "protect-tests", "stop-gate"];

export interface NormalizedEvent {
  event: HookEvent;
  tool?: string;
  input?: any;
  subagent?: string;
  agentType?: string;
  stopHookActive?: boolean;
  cwd: string;
}

export type Decision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "block"; reason: string }
  | { action: "warn"; message: string }
  | { action: "context"; text: string };

/** Blind role names per harness → the payload role they must receive. */
const BLIND_AGENTS: Record<string, "writer" | "repair"> = {
  "test-checker:tcheck-blind-writer": "writer",
  "test-checker:tcheck-repair": "repair",
  "tcheck-blind-writer": "writer",
  "tcheck-repair": "repair",
};

export const HANDOFF_DENY = "Blind roles must receive the exact output of `tcheck bundle emit`. Re-emit and pass it verbatim.";

/** Claude Code / Codex hook JSON → the normalised event (engine-spec §13). */
export function normalize(event: HookEvent, raw: any): NormalizedEvent {
  const input = raw?.tool_input ?? raw?.input;
  return {
    event,
    tool: raw?.tool_name ?? raw?.tool,
    input,
    subagent: input?.subagent_type ?? input?.agent ?? raw?.subagent,
    agentType: raw?.agent_type,
    stopHookActive: !!(raw?.stop_hook_active ?? raw?.stopHookActive),
    cwd: raw?.cwd ?? process.cwd(),
  };
}

function repoFor(ev: NormalizedEvent, root?: string): Repo | null {
  // Fast path: no git calls, just look for a config.
  const r = findRoot({ root, cwd: ev.cwd, gitFallback: false });
  if (!r || !fs.existsSync(path.join(r, STATE_DIR, "config.yaml"))) return null;
  return new Repo(r);
}

function touchHooksSeen(repo: Repo): void {
  const seen = repo.state().hooks_seen_at;
  // state.json is committed: refresh at most hourly to avoid churn.
  if (!seen || Date.now() - Date.parse(seen) > 3600 * 1000) repo.updateState((s) => (s.hooks_seen_at = nowIso()));
}

/** Paths an edit tool would touch: file_path, notebook_path, or apply_patch headers anywhere in the input. */
export function editedPaths(input: any): string[] {
  const out: string[] = [];
  const visit = (v: any, key?: string) => {
    if (typeof v === "string") {
      if (key === "file_path" || key === "notebook_path" || key === "filePath" || key === "path") out.push(v);
      for (const m of v.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) out.push(m[1]);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(input);
  return [...new Set(out)];
}

/** Globs protect-tests guards beyond state.protected: config `protect`, generated tests in test_dir/promote_dir, the generated store. */
export function protectGlobs(repo: Repo): string[] {
  const c = repo.config;
  const pat = c.test_file_pattern.replace(/\{[^}]+\}/g, "*");
  const dirGlob = (d: string) => d.replace(/\{(pkg_dir|package_path)\}/g, "**").replace(/\{[^}]+\}/g, "*").replace(/\/+$/, "");
  const globs = [...c.protect, `${STATE_DIR}/generated/**`, path.posix.join(dirGlob(c.test_dir), pat)];
  if (c.promote_dir) globs.push(path.posix.join(dirGlob(c.promote_dir), pat));
  return globs;
}

function protectTests(repo: Repo, ev: NormalizedEvent): Decision {
  if (process.env.TCHECK_ALLOW_TEST_EDITS === "1") return { action: "allow" };
  const state = repo.state();
  const quarantined = new Set(state.quarantined);
  const globs = protectGlobs(repo);
  for (const p of editedPaths(ev.input)) {
    const rel = toPosix(path.isAbsolute(p) ? path.relative(repo.root, p) : p).replace(/^\.\//, "");
    if (rel.startsWith("..")) continue;
    const entry = state.protected[rel];
    if (!entry && !matchGlobs(rel, globs)) continue;
    const stem = path.posix.basename(rel).split(".")[0];
    const ids = entry?.test_ids ?? [...quarantined].filter((q) => q.split("::")[1]?.split(".").includes(stem));
    if (ids.some((id) => quarantined.has(id))) continue; // test-wrong verdict or user override unlocks it
    const what = entry ? `verified test(s) ${ids.map((i) => i.split("::").pop()).join(", ")}` : rel.startsWith(`${STATE_DIR}/generated/`) ? "a generated blind test" : "a protected test file";
    return {
      action: "deny",
      reason: `${rel} is ${what}. Don't edit tests to make them pass: send the failing test to adjudication (\`tcheck adjudicate prompt <run> <test>\`), or ask the user. A test-wrong verdict or \`tcheck adjudicate override\` unlocks it.`,
    };
  }
  return { action: "allow" };
}

function handoffGuard(repo: Repo, ev: NormalizedEvent): Decision {
  const role = ev.subagent ? BLIND_AGENTS[ev.subagent] : undefined;
  if (!role) return { action: "allow" };
  const prompt = String(ev.input?.prompt ?? "").trim();
  const f = parseFrame(prompt);
  if (!f) return { action: "deny", reason: HANDOFF_DENY };
  const { entry, full } = loadPayload(repo, f.id); // throws on unknown id or hash mismatch → deny
  if (entry.role !== role || entry.consumed || full.trim() !== prompt) return { action: "deny", reason: HANDOFF_DENY };
  return { action: "allow" };
}

function stopGate(repo: Repo, ev: NormalizedEvent): Decision {
  const gate = process.env.TCHECK_GATE === "off" ? "off" : repo.config.gate;
  if (gate === "off") return { action: "allow" };
  const dirty = dirtyFiles(repo);
  if (!dirty.length) return { action: "allow" };
  const list = dirty.slice(0, 10).join(", ") + (dirty.length > 10 ? `, … (${dirty.length - 10} more)` : "");
  const msg = `${dirty.length} changed source file(s) are unverified: ${list}. Run the verify-tests skill, or ask the user to waive.`;
  if (gate === "block" && !ev.stopHookActive) return { action: "block", reason: msg };
  return { action: "warn", message: msg };
}

function sessionStart(repo: Repo): Decision {
  const n = dirtyFiles(repo).length;
  return {
    action: "context",
    text: `test-checker is active (gate: ${repo.config.gate}).${n ? ` ${n} source file(s) changed since last verification. Use the verify-tests skill before finishing work on them.` : ""}`,
  };
}

/** engine-spec §13. Fails open on internal errors, except handoff-guard (fails closed). */
export function evaluateHook(ev: NormalizedEvent, opts: { root?: string } = {}): Decision {
  let repo: Repo | null = null;
  try {
    repo = repoFor(ev, opts.root);
    if (!repo) return { action: "allow" };
    touchHooksSeen(repo);
    let d: Decision;
    switch (ev.event) {
      case "session-start":
        d = sessionStart(repo);
        break;
      case "handoff-guard":
        d = handoffGuard(repo, ev);
        break;
      case "protect-tests":
        d = protectTests(repo, ev);
        break;
      case "stop-gate":
        d = stopGate(repo, ev);
        break;
      default:
        d = { action: "allow" };
    }
    if (d.action === "deny" || d.action === "block") repo.ledger("hook_blocked", { event: ev.event, reason: d.reason });
    return d;
  } catch (e: any) {
    process.stderr.write(`tcheck hook ${ev.event}: internal error: ${e?.message ?? e}\n`);
    if (ev.event === "handoff-guard") {
      try {
        repo?.ledger("hook_blocked", { event: ev.event, reason: `internal error: ${e?.message ?? e}` });
      } catch {}
      return { action: "deny", reason: `${HANDOFF_DENY} (${e?.message ?? e})` };
    }
    return { action: "allow" };
  }
}

/** Claude Code output shapes; Codex accepts the same (VERIFY 6). */
export function hookOutput(d: Decision, harness: string): { stdout: string; stderr: string } {
  void harness;
  switch (d.action) {
    case "deny":
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } }), stderr: "" };
    case "block":
      return { stdout: JSON.stringify({ decision: "block", reason: d.reason }), stderr: "" };
    case "warn":
      return { stdout: JSON.stringify({ systemMessage: d.message }), stderr: "" };
    case "context":
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: d.text } }), stderr: "" };
    default:
      return { stdout: "", stderr: "" };
  }
}

/** `tcheck hook <event>`: stdin JSON in, harness JSON out, always exit 0. */
export async function runHookCli(event: string, harnessFlag?: string, root?: string): Promise<void> {
  if (!HOOK_EVENTS.includes(event as HookEvent)) {
    process.stderr.write(`tcheck hook: unknown event ${event}\n`);
    return;
  }
  let raw: any = {};
  try {
    const text = fs.readFileSync(0, "utf8");
    raw = text.trim() ? JSON.parse(text) : {};
  } catch (e: any) {
    if (event === "handoff-guard") {
      process.stdout.write(hookOutput({ action: "deny", reason: `${HANDOFF_DENY} (unreadable hook input)` }, "claude-code").stdout + "\n");
      return;
    }
    process.stderr.write(`tcheck hook ${event}: unreadable input: ${e?.message ?? e}\n`);
    return;
  }
  debugLog({ hook: event, input: raw });
  const d = evaluateHook(normalize(event as HookEvent, raw), { root });
  const out = hookOutput(d, detectHarness(harnessFlag));
  if (out.stdout) process.stdout.write(out.stdout + "\n");
  if (out.stderr) process.stderr.write(out.stderr + "\n");
}

/** Opt-in trace for confirming harness behaviour (VERIFY items): TCHECK_DEBUG_LOG=<file>. */
export function debugLog(entry: Record<string, unknown>): void {
  const f = process.env.TCHECK_DEBUG_LOG;
  if (!f) return;
  try {
    fs.appendFileSync(f, JSON.stringify({ ts: nowIso(), pid: process.pid, ...entry }) + "\n");
  } catch {}
}

export { globToRegex };
