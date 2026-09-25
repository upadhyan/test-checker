import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tcheck, tmpdir, fixtureRun, dropTests, setConfig } from "./helpers.js";
import { parseJUnit, redactRepairText } from "../dist/tcheck.mjs";

const IMPORT = "from fx.stats import sum_to\n\n";

test("flaky test is detected across reruns and excluded", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  const counter = path.join(tmpdir(), "count");
  setConfig(dir, (c) => c.replace("flake_reruns: 2", "flake_reruns: 3"));
  dropTests(dir, run, target, {
    "test_sum_to_1.py": `${IMPORT}import os\n\ndef test_flaky():\n    p = ${JSON.stringify(counter)}\n    n = int(open(p).read()) if os.path.exists(p) else 0\n    open(p, "w").write(str(n + 1))\n    assert n % 2 == 0\n\ndef test_stable():\n    assert sum_to(3) == 6\n`,
  });
  tcheck(dir, ["compose", run]);
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  const cls = tcheck(dir, ["classify", run, "--json"]).json;
  assert.equal(cls.tests.find((t) => t.name === "test_flaky").category, "flaky");
  assert.equal(cls.tests.find((t) => t.name === "test_stable").category, "effective");
  assert.ok(cls.dropped.some((d) => d.id?.endsWith("test_flaky") && /flaky/.test(d.reason)));
  assert.ok(!cls.queue.some((q) => q.test.endsWith("test_flaky")));
});

test("a hanging run is killed and its tests count as failing", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  setConfig(dir, (c) => c.replace("flake_reruns: 2", "flake_reruns: 1") + "timeouts:\n  per_command_seconds: 2\n");
  // Hangs only on the buggy side (where sum_to(3) == 3).
  dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}import time\n\ndef test_hang_on_bug():\n    if sum_to(3) == 3:\n        time.sleep(30)\n    assert sum_to(3) == 6\n` });
  tcheck(dir, ["compose", run]);
  const t0 = Date.now();
  const r = tcheck(dir, ["exec", run, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Date.now() - t0 < 20000, "timeout enforced");
  const res = JSON.parse(fs.readFileSync(path.join(dir, `.test-checker/runs/${run}/results.json`), "utf8"));
  assert.deepEqual(res.labels.buggy.timed_out, [1]);
  const cls = tcheck(dir, ["classify", run, "--json"]).json;
  const t = cls.tests.find((x) => x.name === "test_hang_on_bug");
  assert.equal(t.outcomes.buggy, "timeout");
  assert.equal(t.category, "effective");
});

test("repairable errors: import errors feed repair, assertion failures never do", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  dropTests(dir, run, target, {
    "test_sum_to_1.py": `from fx.stats import sum_to_missing\n\ndef test_a():\n    assert sum_to_missing(1) == 1\n`,
    "test_sum_to_2.py": `${IMPORT}def test_wrong():\n    assert sum_to(3) == 999, "expected 999"\n`,
  });
  tcheck(dir, ["compose", run]);
  const r = tcheck(dir, ["exec", run, "--json"]);
  assert.equal(r.json.targets[target].status, "needs_repair");
  const rep = JSON.parse(fs.readFileSync(path.join(dir, `.test-checker/runs/${run}/repairable.json`), "utf8"));
  const items = rep.targets[target];
  assert.ok(items.length >= 1);
  const all = items.map((i) => i.text).join("\n");
  assert.match(all, /ImportError|cannot import/);
  assert.ok(items.every((i) => !/test_sum_to_2/.test(i.file ?? "")), "assertion failure file not repairable");
  assert.ok(!all.includes("999"), "no assertion values");
});

test("compile step failure is a round-level repairable error", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  setConfig(dir, (c) => c.replace("commands:\n", "commands:\n  compile: \"python -m py_compile {files}\"\n"));
  dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}def test_x(:\n    pass\n` });
  tcheck(dir, ["compose", run]);
  const r = tcheck(dir, ["exec", run, "--json"]);
  assert.equal(r.json.targets[target].status, "needs_repair");
  const rep = JSON.parse(fs.readFileSync(path.join(dir, `.test-checker/runs/${run}/repairable.json`), "utf8"));
  assert.equal(rep.targets[target][0].kind, "compile");
  assert.match(rep.targets[target][0].text, /SyntaxError|invalid syntax/);
});

test("JUnit parser: outcomes, entities, CDATA, directories", () => {
  const cases = parseJUnit(`<?xml version="1.0"?><testsuites><testsuite name="s">
    <testcase classname="a.b" name="ok" time="0.1"/>
    <testcase classname="a.b" name="bad"><failure message="x &lt; y" type="AssertionError"><![CDATA[trace <here>]]></failure></testcase>
    <testcase classname="a.b" name="err"><error message="boom" type="ImportError">tb</error></testcase>
    <testcase classname="a.b" name="skip"><skipped message="nah"/></testcase>
  </testsuite></testsuites>`);
  assert.deepEqual(cases.map((c) => [c.name, c.outcome]), [["ok", "pass"], ["bad", "failure"], ["err", "error"], ["skip", "skipped"]]);
  assert.equal(cases[1].message, "x < y");
  assert.equal(cases[1].text, "trace <here>");
  assert.equal(cases[2].type, "ImportError");
});

test("junit may be a directory of XML files", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  // Runner writes into {junit} treated as a directory, like Maven surefire.
  setConfig(dir, (c) => c.replace(/run: ".*"/, `run: "mkdir -p {junit} && python -m pytest {files} --junitxml={junit}/TEST-a.xml -q -p no:cacheprovider"`));
  dropTests(dir, run, target, { "test_sum_to_1.py": `${IMPORT}def test_x():\n    assert sum_to(3) == 6\n` });
  tcheck(dir, ["compose", run]);
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  const cls = tcheck(dir, ["classify", run, "--json"]).json;
  assert.equal(cls.tests[0].category, "effective");
});

test("repair redaction strips assertion lines, got-values and body lines, and truncates", () => {
  const target = { id: "t", file: "f.py", body_lines: ["total = compute_the_total(values)", "return total"] };
  const text = [
    "ImportError: cannot import name 'helper'",
    "    total = compute_the_total(values)",
    "E   assert 3 == 6",
    "Expected: 6",
    "actual value was 3",
    "x == 'abc' in line",
    "TypeError: bad thing, got 42 instead",
    "keep me",
  ].join("\n");
  const out = redactRepairText(text, [target]);
  assert.match(out, /ImportError: cannot import name 'helper'/);
  assert.match(out, /\[line from implementation redacted\]/);
  assert.ok(!/compute_the_total/.test(out));
  assert.ok(!/assert 3/.test(out) && !/Expected/.test(out) && !/actual/.test(out) && !/'abc'/.test(out));
  assert.match(out, /got \[value redacted\]/);
  assert.ok(!out.includes("42"));
  assert.match(out, /keep me/);
  assert.ok(redactRepairText("x".repeat(10000), [target]).length <= 4096 + 40);
});
