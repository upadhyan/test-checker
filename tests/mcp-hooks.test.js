import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ENGINE, PATH_WITH_VENV, ROOT, scratchRepo, setConfig, tcheck, tmpdir, fixtureRun, dropTests, composeExecClassify } from "./helpers.js";
import { parseFrame, editedPaths } from "../dist/tcheck.mjs";

const GOOD_SPEC = "<analysis>\nLogical mistakes: n is never added.\nRobustness omissions: none found\n</analysis>\n<spec>\nsum_to(n) returns the sum of the integers 1 through n inclusive; 0 for n == 0; ValueError for n < 0.\n</spec>";

function ready(name = "off_by_one") {
  const f = fixtureRun(name);
  const tmp = tmpdir();
  fs.writeFileSync(path.join(tmp, "spec.txt"), GOOD_SPEC);
  assert.equal(tcheck(f.dir, ["context", "set", f.run, f.target, "--file", path.join(ROOT, "fixtures", name, "context.json")]).code, 0);
  assert.equal(tcheck(f.dir, ["spec", "save", f.run, f.target, "--from", path.join(tmp, "spec.txt")]).code, 0);
  const bundle = tcheck(f.dir, ["bundle", "build", f.run, f.target, "--json"]).json.bundle;
  return { ...f, bundle, emit: (role = "writer") => tcheck(f.dir, ["bundle", "emit", bundle, "--role", role]).stdout };
}

/** Talk to `tcheck mcp` over stdio. */
async function mcp(dir, messages) {
  const child = spawn(process.execPath, [ENGINE, "mcp"], { cwd: tmpdir(), env: { ...process.env, CLAUDE_PROJECT_DIR: dir, PATH: PATH_WITH_VENV } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  return out.trim().split("\n").map((l) => JSON.parse(l));
}

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const INIT = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

test("MCP: initialize, tools/list, submit_tests is single-use and validated", async () => {
  const { dir, target, emit } = ready();
  const id = parseFrame(emit()).id;
  const file = { path: "test_sum_to_1.py", content: "from fx.stats import sum_to\n\ndef test_a():\n    assert sum_to(3) == 6\n" };
  const res = await mcp(dir, [
    INIT,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    call(2, "submit_tests", { payload_id: id, files: [{ path: "../evil.py", content: "x" }] }),
    call(3, "submit_tests", { payload_id: id, files: Array.from({ length: 21 }, (_, i) => ({ path: `test_sum_to_${i}.py`, content: "x" })) }),
    call(4, "submit_tests", { payload_id: id, files: [{ path: "test_sum_to_1.py", content: "x".repeat(210 * 1024) }] }),
    call(5, "submit_tests", { payload_id: id, files: [file], notes: "zero is ambiguous" }),
    call(6, "submit_tests", { payload_id: id, files: [file] }),
    call(7, "save_spec", { payload_id: id, raw_output: "x" }),
  ]);
  assert.equal(res.length, 8, "no reply to the notification");
  assert.equal(res[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(res[1].result.tools.map((t) => t.name), ["submit_tests", "save_spec", "save_verdict"]);
  assert.ok(res[1].result.tools.every((t) => /internal roles only/.test(t.description)));
  const text = (r) => r.result.content[0].text;
  assert.ok(res[2].result.isError && /plain file name/.test(text(res[2])));
  assert.ok(res[3].result.isError && /too many files/.test(text(res[3])));
  assert.ok(res[4].result.isError && /bytes/.test(text(res[4])));
  assert.equal(text(res[5]), `Stored 1 test file for ${target} (round 0).`);
  assert.ok(res[6].result.isError && /already used/.test(text(res[6])));
  assert.ok(res[7].result.isError && /role writer; expected spec/.test(text(res[7])));
});

test("MCP: save_spec and save_verdict go through the same checks as the CLI", async () => {
  const { dir, run, target, emit } = ready();
  const specId = parseFrame(tcheck(dir, ["spec", "prompt", run, target]).stdout).id;
  const leaky = '<spec>\nIt does raise ValueError("n must be non-negative")\n</spec>';
  let res = await mcp(dir, [INIT, call(1, "save_spec", { payload_id: specId, raw_output: leaky }), call(2, "save_spec", { payload_id: specId, raw_output: GOOD_SPEC })]);
  assert.ok(res[1].result.isError && /leak check failed/.test(res[1].result.content[0].text));
  assert.equal(res[2].result.content[0].text, `Spec saved for ${target}. Leak check: passed.`);

  // A misguided test to adjudicate.
  const id = parseFrame(emit()).id;
  await mcp(dir, [INIT, call(1, "submit_tests", { payload_id: id, files: [{ path: "test_sum_to_1.py", content: "from fx.stats import sum_to\n\ndef test_bug():\n    assert sum_to(3) == 3\n" }] })]);
  const { cls } = composeExecClassify(dir, run);
  const tid = cls.queue[0].test;
  const adj = parseFrame(tcheck(dir, ["adjudicate", "prompt", run, tid]).stdout).id;
  res = await mcp(dir, [INIT, call(1, "save_verdict", { payload_id: adj, raw_output: "<verdict>test-wrong</verdict>\n<spec_basis>\"1 through n inclusive\"</spec_basis>\n<reason>3 omits n.</reason>" })]);
  assert.equal(res[1].result.content[0].text, `Verdict recorded: test-wrong for ${tid}.`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".test-checker/state.json"), "utf8")).quarantined, [tid]);
});

// ---------------- hooks ----------------

function hook(dir, event, input, env = {}) {
  const t0 = Date.now();
  const r = tcheck(dir, ["hook", event], { input: JSON.stringify({ cwd: dir, ...input }), env });
  return { ...r, ms: Date.now() - t0, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

test("hooks: no config → immediate allow with no output", () => {
  const dir = scratchRepo();
  for (const ev of ["session-start", "handoff-guard", "protect-tests", "stop-gate"]) {
    const r = hook(dir, ev, { hook_event_name: "X", tool_name: "Edit", tool_input: { file_path: "a", subagent_type: "test-checker:tcheck-blind-writer", prompt: "x" } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", ev);
    assert.ok(r.ms < 1000, `${ev} took ${r.ms}ms`);
  }
});

test("handoff-guard: only the exact, unconsumed payload of the right role passes", () => {
  const { dir, emit } = ready();
  const full = emit();
  const agent = (prompt, subagent_type = "test-checker:tcheck-blind-writer") => hook(dir, "handoff-guard", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type, prompt, description: "d" } });
  assert.equal(agent(full).out, null, "verbatim payload allowed");
  assert.equal(agent(full + "\n\n").out, null, "surrounding whitespace is fine");
  const denied = agent("Please be careful.\n" + full);
  assert.equal(denied.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.out.hookSpecificOutput.permissionDecisionReason, /exact output of `tcheck bundle emit`/);
  assert.equal(agent(full.replace("Specification", "Spec")).out.hookSpecificOutput.permissionDecision, "deny", "hand-edited payload");
  assert.equal(agent(full, "test-checker:tcheck-repair").out.hookSpecificOutput.permissionDecision, "deny", "wrong role");
  assert.equal(agent("anything", "general-purpose").out, null, "other agents untouched");
  // Consumed payloads can't be re-used for a launch.
  const id = parseFrame(full).id;
  const f = path.join(tmpdir(), "o.txt");
  fs.writeFileSync(f, "FILE: test_sum_to_1.py\n```\nx = 1\n```\n");
  assert.equal(tcheck(dir, ["ingest", id, "--from", f]).code, 0);
  assert.equal(agent(full).out.hookSpecificOutput.permissionDecision, "deny");
  // Internal error (corrupt index) fails closed.
  const full2 = emit();
  fs.writeFileSync(path.join(dir, ".test-checker/payloads/index.json"), "{not json");
  assert.equal(agent(full2).out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(fs.readFileSync(path.join(dir, ".test-checker/ledger.jsonl"), "utf8"), /"type":"hook_blocked","event":"handoff-guard"/);
});

test("protect-tests: generated and promoted tests are guarded until quarantined", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  const edit = (file_path, env) => hook(dir, "protect-tests", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path, old_string: "a", new_string: "b" } }, env);
  const gen = `.test-checker/generated/${run}/${target}/round-0/test_sum_to_1.py`;
  const d = edit(path.join(dir, gen));
  assert.equal(d.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(d.out.hookSpecificOutput.permissionDecisionReason, /generated blind test.*adjudication/);
  assert.equal(edit("src/fx/stats.py").out, null, "source edits are fine");
  assert.equal(edit("tests/tcheck/test_sum_to_1.py").out.hookSpecificOutput.permissionDecision, "deny", "test_dir pattern");
  assert.equal(edit("tests/regression/test_sum_to_1.py").out.hookSpecificOutput.permissionDecision, "deny", "promote_dir pattern");
  assert.equal(edit(gen, { TCHECK_ALLOW_TEST_EDITS: "1" }).out, null);
  const patch = hook(dir, "protect-tests", { tool_name: "apply_patch", tool_input: { command: ["apply_patch", `*** Begin Patch\n*** Update File: ${gen}\n@@\n-a\n+b\n*** End Patch`] } });
  assert.equal(patch.out.hookSpecificOutput.permissionDecision, "deny", "apply_patch headers");

  // Promote, then quarantine one test: its file unlocks.
  dropTests(dir, run, target, { "test_sum_to_1.py": "from fx.stats import sum_to\n\ndef test_a():\n    assert sum_to(3) == 6\n" });
  composeExecClassify(dir, run);
  assert.equal(tcheck(dir, ["promote", run]).code, 0);
  const promoted = "tests/regression/test_sum_to_1.py";
  const p = edit(promoted);
  assert.match(p.out.hookSpecificOutput.permissionDecisionReason, /verified test\(s\) test_a/);
  const tid = JSON.parse(fs.readFileSync(path.join(dir, ".test-checker/state.json"), "utf8")).protected[promoted].test_ids[0];
  assert.equal(tcheck(dir, ["adjudicate", "override", run, tid, "--verdict", "test-wrong", "--reason", "user says so"]).code, 0);
  assert.equal(edit(promoted).out, null, "quarantined test's file is editable");
  assert.deepEqual(editedPaths({ notebook_path: "/x/n.ipynb" }), ["/x/n.ipynb"]);
});

test("stop-gate and session-start follow the gate mode", () => {
  const { dir } = fixtureRun("off_by_one");
  const f = path.join(dir, "src/fx/stats.py");
  const stop = (extra = {}, env) => hook(dir, "stop-gate", { hook_event_name: "Stop", ...extra }, env);
  assert.equal(stop().out, null, "gate: off in the fixture config");
  setConfig(dir, (c) => c.replace("gate: off", "gate: warn"));
  assert.equal(stop().out, null, "nothing dirty");
  let s = hook(dir, "session-start", { hook_event_name: "SessionStart", source: "startup" });
  assert.equal(s.out.hookSpecificOutput.additionalContext, "test-checker is active (gate: warn).");
  fs.appendFileSync(f, "\n# edited\n");
  assert.match(stop().out.systemMessage, /1 changed source file\(s\) are unverified: src\/fx\/stats\.py/);
  s = hook(dir, "session-start", { hook_event_name: "SessionStart" });
  assert.match(s.out.hookSpecificOutput.additionalContext, /1 source file\(s\) changed since last verification/);
  setConfig(dir, (c) => c.replace("gate: warn", "gate: block"));
  assert.equal(stop().out.decision, "block");
  assert.ok(stop({ stop_hook_active: true }).out.systemMessage, "no loops");
  assert.equal(stop({}, { TCHECK_GATE: "off" }).out, null);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, ".test-checker/state.json"), "utf8")).hooks_seen_at);
  assert.equal(tcheck(dir, ["env", "--json"]).json.hooks_seen, true);
});

test("hooks fail open on internal errors (except handoff-guard)", () => {
  const { dir } = fixtureRun("off_by_one");
  setConfig(dir, (c) => c.replace("gate: off", "gate: block"));
  fs.appendFileSync(path.join(dir, "src/fx/stats.py"), "\n# edited\n");
  fs.writeFileSync(path.join(dir, ".test-checker/state.json"), "{broken");
  const r = hook(dir, "stop-gate", { hook_event_name: "Stop" });
  assert.equal(r.code, 0);
  assert.equal(r.out, null);
  assert.match(r.stderr, /internal error/);
});
