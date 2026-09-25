import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { git, tcheck, tmpdir, fixtureRun, dropTests, composeExecClassify } from "./helpers.js";
import { buildFixtureRepo, parseFrame, parseVerdict, mapRange, Repo } from "../dist/tcheck.mjs";

const IMPORT = "from fx.stats import sum_to\n\n";
const write = (s) => {
  const f = path.join(tmpdir(), "out.txt");
  fs.writeFileSync(f, s);
  return f;
};

test("parseVerdict: exact verdicts, code-wrong without a spec basis is downgraded", () => {
  assert.equal(parseVerdict("<verdict>test-wrong</verdict><spec_basis>none</spec_basis><reason>r</reason>").verdict, "test-wrong");
  const d = parseVerdict("<verdict>code-wrong</verdict>\n<spec_basis>none</spec_basis>\n<reason>r</reason>");
  assert.equal(d.verdict, "spec-ambiguous");
  assert.match(d.warning, /downgraded/);
  assert.equal(parseVerdict('<verdict>code-wrong</verdict><spec_basis>"includes n"</spec_basis><reason>r</reason>').verdict, "code-wrong");
  assert.throws(() => parseVerdict("<verdict>code-wrong | test-wrong</verdict>"), /exactly one of/);
});

test("mapRange follows insertions and edits between revisions", () => {
  const { dir, buggy, fixed } = buildFixtureRepo("null_guard");
  const repo = new Repo(dir);
  assert.deepEqual(mapRange(repo, buggy, fixed, "src/fx/names.py", [4, 5]), [4, 7]);
  const s = buildFixtureRepo("stale_state");
  assert.deepEqual(mapRange(new Repo(s.dir), s.buggy, s.fixed, "src/fx/counter.py", [21, 22]), [21, 23]);
});

test("adjudicate → report → promote in bugfix mode", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  dropTests(dir, run, target, {
    "test_sum_to_1.py": `${IMPORT}def test_includes_n():\n    assert sum_to(3) == 6\n\ndef test_zero():\n    assert sum_to(0) == 0\n`,
    "test_sum_to_2.py": `${IMPORT}def test_buggy_value():\n    assert sum_to(3) == 3\n`,
  });
  composeExecClassify(dir, run);
  const tid = `${target}::tests.tcheck.test_sum_to_2::test_buggy_value`;
  let q = tcheck(dir, ["adjudicate", "queue", run, "--json"]).json;
  assert.deepEqual(q.map((x) => [x.test, x.category, x.status]), [[tid, "misguided", "pending"]]);

  // The adjudicator sees the FIXED implementation (spec source is buggy) and the fixed-side failure.
  let r = tcheck(dir, ["adjudicate", "prompt", run, tid]);
  assert.equal(r.code, 0, r.stderr);
  const fr = parseFrame(r.stdout);
  assert.equal(fr.role, "adjudicate");
  assert.match(fr.body, /range\(n \+ 1\)/);
  assert.match(fr.body, /at `fixed \(/);
  assert.match(fr.body, /def test_buggy_value/);
  assert.match(fr.body, /Outcome on fixed: failure/);
  assert.equal(tcheck(dir, ["adjudicate", "prompt", run, `${target}::x::y`]).code, 1);

  // code-wrong without a spec sentence → spec-ambiguous → blocks promote.
  r = tcheck(dir, ["adjudicate", "save", run, tid, "--from", write("<verdict>code-wrong</verdict>\n<spec_basis>none</spec_basis>\n<reason>Which total is intended for n=3?</reason>"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.verdict, "spec-ambiguous");
  r = tcheck(dir, ["promote", run]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unresolved verdicts[\s\S]*spec-ambiguous/);
  let rep = tcheck(dir, ["report", run, "--json"]).json;
  assert.equal(rep.needs_decision.length, 1);
  assert.equal(rep.needs_decision[0].question, "Which total is intended for n=3?");

  // The user decides: the test is wrong → quarantined, excluded from promote.
  r = tcheck(dir, ["adjudicate", "override", run, tid, "--verdict", "test-wrong", "--reason", "3 is the buggy value", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, ".test-checker/state.json"), "utf8"));
  assert.deepEqual(state().quarantined, [tid]);
  q = tcheck(dir, ["adjudicate", "queue", run, "--json"]).json;
  assert.equal(q[0].verdict, "test-wrong");
  assert.equal(q[0].source, "user");

  r = tcheck(dir, ["report", run]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.trim().split("\n").length <= 10);
  const md = fs.readFileSync(path.join(dir, `.test-checker/reports/${run}.md`), "utf8");
  const order = ["## Summary", "## Likely bugs", "## Suspicions", "## Needs your decision", "## Misguided tests and what happened to them", "## Dropped", "## Promotable tests"];
  const idx = order.map((h) => md.indexOf(h));
  assert.ok(idx.every((i, k) => i > 0 && (k === 0 || i > idx[k - 1])), "sections in §12 order");
  assert.match(md, /test_buggy_value \(misguided\): test-wrong \(user\)/);
  assert.match(md, /quarantined \(test-wrong\)/);
  rep = JSON.parse(fs.readFileSync(path.join(dir, `.test-checker/reports/${run}.json`), "utf8"));
  assert.deepEqual(rep.promotable.map((p) => p.dest), ["tests/regression/test_sum_to_1.py"]);
  assert.match(rep.not_promotable[0].reason, /quarantined/);

  r = tcheck(dir, ["promote", run, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.promoted.map((p) => p.dest), ["tests/regression/test_sum_to_1.py"]);
  assert.equal(fs.readFileSync(path.join(dir, "tests/regression/test_sum_to_1.py"), "utf8"), `${IMPORT}def test_includes_n():\n    assert sum_to(3) == 6\n\ndef test_zero():\n    assert sum_to(0) == 0\n`);
  const s = state();
  assert.deepEqual(Object.keys(s.protected), ["tests/regression/test_sum_to_1.py"]);
  assert.equal(s.verified["src/fx/stats.py"].sha, git(dir, "rev-parse", "HEAD:src/fx/stats.py").trim());
  assert.deepEqual(tcheck(dir, ["status", "--json"]).json.dirty_files, []);
});

test("code-wrong blocks promote until the code is fixed and exec shows the test passing", () => {
  const { dir } = buildFixtureRepo("off_by_one");
  git(dir, "reset", "-q", "--hard", "HEAD~1"); // working tree = buggy; the 'fix' isn't written yet
  const run = tcheck(dir, ["run", "start", "--mode", "bugfix", "--json"]).json.run; // buggy HEAD vs WORKTREE
  const target = tcheck(dir, ["target", "add", run, "src/fx/stats.py::sum_to", "--lines", "4-10", "--json"]).json.target;
  dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}def test_includes_n():\n    assert sum_to(3) == 6\n` });
  let { cls } = composeExecClassify(dir, run);
  const tid = cls.tests[0].id;
  assert.equal(cls.tests[0].category, "broken");
  let r = tcheck(dir, ["adjudicate", "save", run, tid, "--from", write('<verdict>code-wrong</verdict>\n<spec_basis>"returns the sum of 1 through n inclusive"</spec_basis>\n<reason>n is omitted.</reason>')]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tcheck(dir, ["promote", run]).code, 2);
  assert.equal(tcheck(dir, ["report", run, "--json"]).json.likely_bugs[0].spec_basis, '"returns the sum of 1 through n inclusive"');
  assert.equal(tcheck(dir, ["status", "--json"]).json.unresolved_verdicts.length, 0, "reported runs are closed");

  // Fix the code, re-run exec: the WORKTREE side is re-snapshotted and the test now passes.
  const f = path.join(dir, "src/fx/stats.py");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("range(n)", "range(n + 1)"));
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  cls = tcheck(dir, ["classify", run, "--json"]).json;
  assert.equal(cls.tests[0].category, "effective");
  r = tcheck(dir, ["promote", run, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.promoted.length, 1);
  assert.deepEqual(tcheck(dir, ["status", "--json"]).json.dirty_files, [], "the fixed file is verified");
});
