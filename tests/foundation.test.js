import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, scratchRepo, tcheck } from "./helpers.js";
import { parseYaml, parseConfig, matchGlobs, detectHarness } from "../dist/tcheck.mjs";

test("YAML parser loads every example config and validates it", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "examples"))) {
    const text = fs.readFileSync(path.join(ROOT, "examples", f), "utf8");
    const c = parseConfig(text, f);
    assert.equal(c.version, 1, f);
    assert.ok(c.commands.run.includes("{junit}"), f);
    assert.equal(c.flake_reruns, 3);
  }
});

test("YAML subset: nesting, flow, quotes, block scalars, comments", () => {
  const y = parseYaml(`a: 1 # c\nb: "x # not a comment"\nc: [1, 'two', "three"]\nd:\n  - x\n  - k: v\n    k2: [a, b]\ne:\n  f: null\n  g: true\nh: |\n  line1\n  line2\ni: {p: 1, q: "r"}\n`);
  assert.deepEqual(y, { a: 1, b: "x # not a comment", c: [1, "two", "three"], d: ["x", { k: "v", k2: ["a", "b"] }], e: { f: null, g: true }, h: "line1\nline2\n", i: { p: 1, q: "r" } });
});

test("invalid config is rejected with exit code 2 and a path", () => {
  assert.throws(() => parseConfig("version: 1\nlanguage: x\n"), (e) => e.code === 2 && /missing required "framework"/.test(e.message));
  assert.throws(() => parseConfig("version: 1\nlanguage: x\nframework: y\nsource_globs: [a]\ntest_dir: t\ntest_file_pattern: t.py\ncommands:\n  run: x\n"), /test_file_pattern: must match/);
});

test("globs support ** and negation", () => {
  assert.ok(matchGlobs("src/a/b.py", ["src/**/*.py"]));
  assert.ok(matchGlobs("src/b.py", ["src/**/*.py"]));
  assert.ok(!matchGlobs("lib/b.py", ["src/**/*.py"]));
  assert.ok(matchGlobs("pkg/x.go", ["**/*.go", "!**/*_test.go"]));
  assert.ok(!matchGlobs("pkg/x_test.go", ["**/*.go", "!**/*_test.go"]));
});

test("harness detection precedence", () => {
  assert.equal(detectHarness("pi", { CLAUDECODE: "1" }), "pi");
  assert.equal(detectHarness(undefined, { TCHECK_HARNESS: "opencode", CLAUDECODE: "1" }), "opencode");
  assert.equal(detectHarness(undefined, { CLAUDECODE: "1" }), "claude-code");
  assert.equal(detectHarness(undefined, { PLUGIN_ROOT: "/x" }), "codex");
  assert.equal(detectHarness(undefined, {}), "unknown");
});

test("env --json and init in a scratch repo", () => {
  const dir = scratchRepo({ "pyproject.toml": "" });
  let r = tcheck(dir, ["env", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.config, "missing");
  assert.equal(r.json.repo_root, dir);
  for (const k of ["harness", "engine", "plugin_root", "harness_reference", "node", "git", "blind_backend", "blind_isolation", "hooks_seen", "gate", "dirty_files", "warnings"]) assert.ok(k in r.json, k);

  r = tcheck(dir, ["init", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.example, "config.python.yaml");
  assert.ok(fs.readFileSync(path.join(dir, ".test-checker/.gitignore"), "utf8").includes("worktrees/"));
  assert.equal(tcheck(dir, ["init"]).code, 1, "refuses to overwrite");
  assert.equal(tcheck(dir, ["init", "--force", "--language", "go"]).code, 0);
  r = tcheck(dir, ["env", "--json"]);
  assert.equal(r.json.config, "present");
  assert.equal(r.json.gate, "warn");
  const ledger = fs.readFileSync(path.join(dir, ".test-checker/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(ledger.every((e) => e.ts && e.type));
});

test("unknown command is a usage error", () => {
  assert.equal(tcheck(ROOT, ["nope"]).code, 1);
});
