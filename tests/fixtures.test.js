import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, fixtureRun, dropTests, composeExecClassify } from "./helpers.js";
import { listFixtures } from "../dist/tcheck.mjs";

/** One hand-written bug-catching test per fixture, plus one that enshrines the bug. */
const CASES = {
  off_by_one: ["from fx.stats import sum_to", "assert sum_to(3) == 6", "assert sum_to(3) == 3"],
  boundary: ["from fx.ranges import in_range", "assert in_range(5, 1, 5) is True", "assert in_range(5, 1, 5) is False"],
  null_guard: ["from fx.names import normalize_name\nimport pytest", "with pytest.raises(ValueError):\n        normalize_name(None)", "with pytest.raises(AttributeError):\n        normalize_name(None)"],
  wrong_operator: ["from fx.net import is_valid_port", "assert is_valid_port(0) is False", "assert is_valid_port(0) is True"],
  stale_state: ["from fx.counter import Counter", "c = Counter()\n    c.add(1)\n    c.reset()\n    assert c.add(1) is True", "c = Counter()\n    c.add(1)\n    c.reset()\n    assert c.add(1) is False"],
};

test("every fixture has the documented layout", () => {
  assert.deepEqual(listFixtures(), Object.keys(CASES).sort());
  for (const name of listFixtures()) {
    for (const f of ["fixture.yaml", "config.yaml", "context.json", "buggy", "fixed"]) assert.ok(fs.existsSync(path.join(ROOT, "fixtures", name, f)), `${name}/${f}`);
  }
});

for (const [name, [imports, catches, enshrines]] of Object.entries(CASES)) {
  test(`fixture ${name}: a bug-catching test is effective, a bug-enshrining one misguided`, () => {
    const { dir, run, target } = fixtureRun(name);
    dropTests(dir, run, target, {
      [`test_${name}_1.py`]: `${imports}\n\n\ndef test_catches():\n    ${catches}\n\n\ndef test_enshrines():\n    ${enshrines}\n`,
    });
    const { cls } = composeExecClassify(dir, run);
    assert.equal(cls.tests.find((t) => t.name === "test_catches").category, "effective", JSON.stringify(cls.tests));
    assert.equal(cls.tests.find((t) => t.name === "test_enshrines").category, "misguided");
  });
}
