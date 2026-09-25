import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { git, tcheck, writeFiles } from "./helpers.js";
import { buildFixtureRepo } from "../dist/tcheck.mjs";

/** Start a bugfix run on a fixture and register its target. */
export function fixtureRun(name, extra = {}) {
  const { dir, buggy, fixed, fixture } = buildFixtureRepo(name);
  let r = tcheck(dir, ["run", "start", "--mode", "bugfix", "--buggy", buggy, "--fixed", fixed, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const run = r.json.run;
  r = tcheck(dir, ["target", "add", run, fixture.target, "--lines", fixture.lines.join("-"), "--json", ...(extra.targetArgs ?? [])]);
  assert.equal(r.code, 0, r.stderr);
  return { dir, run, target: r.json.target, fixture, buggy, fixed };
}

/** Drop hand-written test files straight into a generated round (no model involved). */
export function dropTests(dir, run, target, files, round = 0) {
  writeFiles(path.join(dir, ".test-checker", "generated", run, target, `round-${round}`), files);
}

export function composeExecClassify(dir, run) {
  let r = tcheck(dir, ["compose", run, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  r = tcheck(dir, ["exec", run, "--json"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const exec = r.json;
  r = tcheck(dir, ["classify", run, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  return { exec, cls: r.json };
}

const byName = (cls, name) => cls.tests.find((t) => t.name === name);

test("tracer: hand-written tests on off_by_one classify effective and misguided", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  assert.equal(target, "src-fx-stats-py--sum-to");
  const statusBefore = git(dir, "status", "--porcelain");
  dropTests(dir, run, target, {
    "test_sum_to_1.py": [
      "from fx.stats import sum_to",
      "",
      "def test_sum_to_three_includes_n():",
      "    assert sum_to(3) == 6",
      "",
      "def test_sum_to_three_buggy_value():",
      "    assert sum_to(3) == 3",
      "",
      "def test_zero():",
      "    assert sum_to(0) == 0",
      "",
    ].join("\n"),
  });
  const { exec, cls } = composeExecClassify(dir, run);
  assert.deepEqual(exec.targets[target], { status: "ok" });
  assert.equal(byName(cls, "test_sum_to_three_includes_n").category, "effective");
  assert.equal(byName(cls, "test_sum_to_three_buggy_value").category, "misguided");
  assert.equal(byName(cls, "test_zero").category, "neutral");
  assert.deepEqual(cls.queue.map((q) => q.test.split("::").pop()), ["test_sum_to_three_buggy_value"]);
  // Invariant 4: the user's working tree is untouched.
  assert.equal(git(dir, "status", "--porcelain"), statusBefore);
  assert.ok(!fs.existsSync(path.join(dir, "tests")));
  const ledger = fs.readFileSync(path.join(dir, ".test-checker/ledger.jsonl"), "utf8");
  for (const t of ["run_started", "target_added", "exec_completed", "classified"]) assert.ok(ledger.includes(`"type":"${t}"`), t);
});
