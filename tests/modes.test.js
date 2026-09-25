import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { git, tcheck, dropTests, setConfig, writeFiles } from "./helpers.js";
import { buildFixtureRepo } from "../dist/tcheck.mjs";

const IMPORT = "from fx.stats import sum_to\n\n";
const TARGET = ["src/fx/stats.py::sum_to", "--lines", "4-10"];

test("WORKTREE snapshot includes uncommitted and untracked files without touching the index", () => {
  const { dir, fixed } = buildFixtureRepo("off_by_one");
  git(dir, "reset", "-q", "--hard", "HEAD~1"); // back to the buggy commit
  fs.writeFileSync(path.join(dir, "src/fx/stats.py"), fs.readFileSync(path.join(dir, "src/fx/stats.py"), "utf8").replace("range(n)", "range(n + 1)"));
  writeFiles(dir, { "src/fx/extra.py": "X = 1\n" });
  git(dir, "add", "src/fx/extra.py"); // staged-but-uncommitted file must stay staged
  const statusBefore = git(dir, "status", "--porcelain");
  const indexBefore = git(dir, "ls-files", "--stage");
  const r = tcheck(dir, ["run", "start", "--mode", "bugfix", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(git(dir, "status", "--porcelain"), statusBefore);
  assert.equal(git(dir, "ls-files", "--stage"), indexBefore);
  const snap = r.json.revisions.fixed;
  assert.equal(git(dir, "rev-parse", `refs/tcheck/${r.json.run}/worktree`).trim(), snap);
  assert.match(git(dir, "show", `${snap}:src/fx/stats.py`), /range\(n \+ 1\)/);
  assert.equal(git(dir, "show", `${snap}:src/fx/extra.py`), "X = 1\n");
  // Same tree as the real fix commit apart from the extra file.
  assert.equal(git(dir, "rev-parse", `${snap}:src/fx/stats.py`), git(dir, "rev-parse", `${fixed}:src/fx/stats.py`));
});

test("new mode: pass → accepted, fail → disputed and queued", () => {
  const { dir } = buildFixtureRepo("off_by_one");
  git(dir, "reset", "-q", "--hard", "HEAD~1"); // current code is the buggy version
  const run = tcheck(dir, ["run", "start", "--mode", "new", "--json"]).json.run;
  const target = tcheck(dir, ["target", "add", run, ...TARGET, "--json"]).json.target;
  dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}def test_includes_n():\n    assert sum_to(3) == 6\n\ndef test_zero():\n    assert sum_to(0) == 0\n` });
  tcheck(dir, ["compose", run]);
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  const cls = tcheck(dir, ["classify", run, "--json"]).json;
  const cat = (n) => cls.tests.find((t) => t.name === n).category;
  assert.equal(cat("test_includes_n"), "disputed");
  assert.equal(cat("test_zero"), "accepted");
  assert.deepEqual(cls.queue.map((q) => [q.test.split("::").pop(), q.revision]), [["test_includes_n", "current"]]);
});

test("audit mode pairs a disputed blind test with a passing existing test on the same unit", () => {
  const { dir } = buildFixtureRepo("off_by_one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  writeFiles(dir, { "tests/test_existing.py": `${IMPORT}def test_existing_three():\n    assert sum_to(3) == 3\n` });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "existing test");
  const run = tcheck(dir, ["run", "start", "--mode", "audit", "--existing", "tests/test_existing.py", "--json"]).json.run;
  const target = tcheck(dir, ["target", "add", run, ...TARGET, "--json"]).json.target;
  dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}def test_includes_n():\n    assert sum_to(3) == 6\n` });
  tcheck(dir, ["compose", run]);
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  const cls = tcheck(dir, ["classify", run, "--json"]).json;
  const existing = cls.tests.find((t) => t.existing);
  assert.equal(existing.category, "accepted");
  assert.equal(cls.queue.length, 1);
  assert.deepEqual(cls.queue[0].pair, [existing.id]);
  assert.equal(cls.counts.existing.accepted, 1);
});

test("audit rewrite: after the fix only the suspect that fails is bad; it is deleted and the blind test is promoted", () => {
  const { dir } = buildFixtureRepo("off_by_one");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  writeFiles(dir, {
    "tests/test_existing.py": `${IMPORT}def test_existing_three():\n    assert sum_to(3) == 3\n`,
    "tests/test_other.py": `${IMPORT}def test_zero():\n    assert sum_to(0) == 0\n`,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "existing tests");
  const run = tcheck(dir, ["run", "start", "--mode", "audit", "--existing", "tests/test_existing.py", "tests/test_other.py", "--json"]).json.run;
  const target = tcheck(dir, ["target", "add", run, ...TARGET, "--json"]).json.target;
  dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}def test_includes_n():\n    assert sum_to(3) == 6\n` });
  tcheck(dir, ["compose", run]);
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  let cls = tcheck(dir, ["classify", run, "--json"]).json;
  const blind = cls.queue[0].test;
  const suspect = cls.tests.find((t) => t.name === "test_existing_three").id;
  const bystander = cls.tests.find((t) => t.name === "test_zero").id;
  const verdict = path.join(dir, "verdict.txt");
  fs.writeFileSync(verdict, '<verdict>code-wrong</verdict>\n<spec_basis>"sum of 1 through n inclusive"</spec_basis>\n<reason>n is omitted.</reason>');
  assert.equal(tcheck(dir, ["adjudicate", "save", run, blind, "--from", verdict]).code, 0);
  assert.deepEqual(tcheck(dir, ["report", run, "--json"]).json.likely_bugs[0].suspect_existing.sort(), [suspect, bystander].sort(), "pairing is by unit name, so both are suspects");
  assert.equal(tcheck(dir, ["promote", run, "--tests", blind]).code, 2, "blocked until the code is fixed");

  // Fix the code: the blind test passes, the suspect existing test now fails.
  const f = path.join(dir, "src/fx/stats.py");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("range(n)", "range(n + 1)"));
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  cls = tcheck(dir, ["classify", run, "--json"]).json;
  const cat = (id) => cls.tests.find((t) => t.id === id).category;
  assert.equal(cat(blind), "accepted");
  assert.equal(cat(suspect), "disputed", "the bad test fails once the code is fixed");
  assert.equal(cat(bystander), "accepted", "a suspect that still passes is kept");

  // Delete the bad test (its file held nothing else); exec still runs, then promote the replacement.
  fs.rmSync(path.join(dir, "tests/test_existing.py"));
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  tcheck(dir, ["classify", run]);
  const r = tcheck(dir, ["promote", run, "--tests", `${blind}\n`, "--json"]); // a quoted "$IDS" list, as agents pass it
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.promoted.length, 1);
  assert.ok(fs.existsSync(path.join(dir, "tests/test_other.py")), "other existing tests are kept");
});

test("new mode with mutation: accepted tests that kill a mutant are effective", () => {
  const { dir } = buildFixtureRepo("off_by_one");
  // A mutate command prints one JSON object per line: {id, file, patch}.
  writeFiles(dir, {
    "mutate.py": [
      "import json, difflib",
      "src = open('src/fx/stats.py').read()",
      "mut = src.replace('range(n + 1)', 'range(n)')",
      "patch = ''.join(difflib.unified_diff(src.splitlines(True), mut.splitlines(True), 'a/src/fx/stats.py', 'b/src/fx/stats.py'))",
      "print(json.dumps({'id': 'm1', 'file': 'src/fx/stats.py', 'patch': patch}))",
      "",
    ].join("\n"),
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "mutator");
  setConfig(dir, (c) => c.replace("commands:\n", 'commands:\n  mutate: "python mutate.py"\n'));
  const run = tcheck(dir, ["run", "start", "--mode", "new", "--json"]).json.run;
  const target = tcheck(dir, ["target", "add", run, ...TARGET, "--json"]).json.target;
  dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}def test_includes_n():\n    assert sum_to(3) == 6\n\ndef test_zero():\n    assert sum_to(0) == 0\n` });
  tcheck(dir, ["compose", run]);
  const r = tcheck(dir, ["exec", run, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const cls = tcheck(dir, ["classify", run, "--json"]).json;
  const t = cls.tests.find((x) => x.name === "test_includes_n");
  assert.equal(t.category, "accepted");
  assert.deepEqual(t.extra, ["effective"]);
  assert.equal(cls.tests.find((x) => x.name === "test_zero").extra, undefined);
  assert.deepEqual(cls.kill_rate[target], { killed: 1, total: 1 });
});

test("worktrees are cached per commit and reused across runs", () => {
  const { dir, buggy, fixed } = buildFixtureRepo("off_by_one");
  const mk = () => {
    const run = tcheck(dir, ["run", "start", "--mode", "bugfix", "--buggy", buggy, "--fixed", fixed, "--json"]).json.run;
    const target = tcheck(dir, ["target", "add", run, ...TARGET, "--json"]).json.target;
    dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}def test_a():\n    assert sum_to(3) == 6\n` });
    tcheck(dir, ["compose", run]);
    assert.equal(tcheck(dir, ["exec", run]).code, 0);
    return run;
  };
  mk();
  mk();
  const cache = fs.readdirSync(path.join(dir, ".test-checker/worktrees/_cache")).filter((d) => !d.endsWith(".json"));
  assert.deepEqual(cache.sort(), [buggy, fixed].sort());
});

test("a new cached worktree prunes entries unused for a week", () => {
  const { dir, buggy, fixed } = buildFixtureRepo("off_by_one");
  const cache = path.join(dir, ".test-checker/worktrees/_cache");
  const run = (b, f) => {
    const id = tcheck(dir, ["run", "start", "--mode", "bugfix", "--buggy", b, "--fixed", f, "--json"]).json.run;
    const target = tcheck(dir, ["target", "add", id, ...TARGET, "--json"]).json.target;
    dropTests(dir, id, target, { "test_sum_to_1.py": `${IMPORT}def test_a():\n    assert sum_to(3) == 6\n` });
    tcheck(dir, ["compose", id]);
    assert.equal(tcheck(dir, ["exec", id]).code, 0);
  };
  run(buggy, fixed);
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(cache, `${buggy}.json`), old, old);
  writeFiles(dir, { "src/fx/extra.py": "X = 1\n" }); // a new WORKTREE snapshot needs a fresh worktree
  run(fixed, "WORKTREE");
  const left = fs.readdirSync(cache).filter((d) => !d.endsWith(".json"));
  assert.ok(!left.includes(buggy), "stale worktree removed");
  assert.ok(left.includes(fixed), "recently used worktree kept");
  assert.equal(left.length, 2);
  assert.ok(!git(dir, "worktree", "list").includes(buggy), "git forgets it too");
});
