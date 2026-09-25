import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fixtureRun, setConfig } from "./helpers.js";
import { TestChecker } from "../.opencode/plugins/test-checker.mjs";

test("OpenCode plugin: hidden deny-all agents, guards, session context, stop gate", async () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  setConfig(dir, (c) => c.replace("gate: off", "gate: block"));
  const prompts = [];
  const client = { session: { prompt: async (req) => prompts.push(req) }, tui: { showToast: async () => {} } };
  const hooks = await TestChecker({ client, directory: dir });

  const config = {};
  await hooks.config(config);
  assert.deepEqual(Object.keys(config.agent).sort(), ["tcheck-adjudicator", "tcheck-blind-writer", "tcheck-repair", "tcheck-spec-extractor"]);
  const w = config.agent["tcheck-blind-writer"];
  assert.equal(w.mode, "subagent");
  assert.equal(w.hidden, true);
  assert.equal(w.permission.read, "deny");
  assert.deepEqual(w.tools, { "*": false, tcheck_submit_tests: true });
  assert.match(w.prompt, /blind test writer/);
  assert.ok(!w.prompt.startsWith("---"));

  const env = { env: {} };
  await hooks["shell.env"]({ cwd: dir }, env);
  assert.equal(env.env.TCHECK_HARNESS, "opencode");

  await assert.rejects(hooks["tool.execute.before"]({ tool: "task", sessionID: "s", callID: "c" }, { args: { subagent_type: "tcheck-blind-writer", prompt: "write tests for sum_to", description: "x" } }), /exact output of `tcheck bundle emit`/);
  await hooks["tool.execute.before"]({ tool: "task", sessionID: "s", callID: "c" }, { args: { subagent_type: "general", prompt: "hi" } });
  await assert.rejects(hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c" }, { args: { filePath: path.join(dir, `.test-checker/generated/${run}/${target}/round-0/test_sum_to_1.py`) } }), /generated blind test/);

  const sys = { system: [] };
  await hooks["experimental.chat.system.transform"]({ model: {} }, sys);
  assert.deepEqual(sys.system, ["test-checker is active (gate: block)."]);

  fs.appendFileSync(path.join(dir, "src/fx/stats.py"), "\n# edited\n");
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].body.parts[0].text, /unverified: src\/fx\/stats\.py/);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(prompts.length, 1, "no nudge loop");
});
