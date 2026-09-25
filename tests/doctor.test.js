import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { git, scratchRepo, setConfig, tcheck, writeFiles } from "./helpers.js";

function pythonRepo() {
  const dir = scratchRepo({ "pyproject.toml": "[project]\nname = 'p'\n", "src/pkg/__init__.py": "", "src/pkg/mod.py": "def f(x):\n    return x + 1\n" });
  assert.equal(tcheck(dir, ["init", "--language", "python"]).code, 0);
  return dir;
}

test("doctor passes on a Python repo with examples/config.python.yaml and leaves no trace", () => {
  const dir = pythonRepo();
  const statusBefore = git(dir, "status", "--porcelain");
  const r = tcheck(dir, ["doctor", "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.match(r.json.checks.find((c) => c.name === "junit").detail, /1 pass, 1 fail/);
  assert.equal(git(dir, "status", "--porcelain"), statusBefore);
  assert.equal(git(dir, "worktree", "list").trim().split("\n").length, 1, "scratch worktree removed");
  assert.equal(git(dir, "for-each-ref", "refs/tcheck/").trim(), "");
});

test("doctor explains a run command that writes no JUnit", () => {
  const dir = pythonRepo();
  setConfig(dir, (c) => c.replace(/run: ".*"/, 'run: "python -m pytest {files} -q # {junit}"'));
  const r = tcheck(dir, ["doctor", "--json"]);
  assert.equal(r.code, 4);
  const junit = r.json.checks.find((c) => c.name === "junit");
  assert.equal(junit.ok, false);
  assert.match(junit.fix, /must write JUnit XML to \{junit\}/);
});

test("doctor rejects an invalid config with exit 2", () => {
  const dir = pythonRepo();
  setConfig(dir, (c) => c.replace("framework: pytest", "framework: 3"));
  const r = tcheck(dir, ["doctor", "--json"]);
  assert.equal(r.code, 2);
  assert.match(r.json.checks[0].detail, /framework: expected string/);
});

test("unknown framework asks for agent-written tests, then --use runs them", () => {
  const dir = pythonRepo();
  setConfig(dir, (c) => c.replace("framework: pytest", "framework: mytestlib"));
  let r = tcheck(dir, ["doctor"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Write two trivial python tests.*tcheck doctor --use/s);
  const tmp = path.join(dir, "..", path.basename(dir) + "-use");
  fs.mkdirSync(tmp);
  writeFiles(tmp, { "test_a_1.py": "def test_ok():\n    assert True\n", "test_a_2.py": "def test_no():\n    assert False\n" });
  r = tcheck(dir, ["doctor", "--use", path.join(tmp, "test_a_1.py"), path.join(tmp, "test_a_2.py"), "--json"]);
  assert.equal(r.code, 0, r.stdout);
});
