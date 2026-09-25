import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATH_WITH_VENV, ROOT, tcheck, tmpdir, fixtureRun } from "./helpers.js";

const FAKE_BIN = path.join(ROOT, "tests", "fake-cli");
fs.chmodSync(path.join(FAKE_BIN, "claude"), 0o755);

function fakeEnv() {
  const log = path.join(tmpdir(), "calls.jsonl");
  return { log, env: { PATH: `${FAKE_BIN}${path.delimiter}${PATH_WITH_VENV}`, FAKE_CLI_LOG: log, CLAUDECODE: "1", CLAUDE_PROJECT_DIR: "" } };
}
const calls = (log) => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("blind-run refuses in a harness with native subagents", () => {
  const { dir } = fixtureRun("off_by_one");
  const r = tcheck(dir, ["blind-run", "b-x", "--role", "writer", "--harness", "claude-code"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /native blind role/);
});

test("blind-run --backend claude: isolated temp dir, no tools, payload never printed, tests ingested", () => {
  const { dir, run, target } = fixtureRun("off_by_one");
  const { log, env } = fakeEnv();
  const tmp = tmpdir();
  fs.writeFileSync(path.join(tmp, "spec.txt"), "<spec>\nsum_to(n) returns 1 + … + n.\n</spec>");
  tcheck(dir, ["context", "set", run, target, "--file", path.join(ROOT, "fixtures/off_by_one/context.json")]);
  tcheck(dir, ["spec", "save", run, target, "--from", path.join(tmp, "spec.txt")]);
  const bundle = tcheck(dir, ["bundle", "build", run, target, "--json"]).json.bundle;
  const r = tcheck(dir, ["blind-run", bundle, "--role", "writer", "--backend", "claude"], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Stored 1 test file .* \(backend: claude, isolation: medium\)/);
  assert.ok(!r.stdout.includes("TCHECK-PAYLOAD"), "payload not printed");
  const [c] = calls(log);
  assert.equal(c.role, "writer");
  assert.deepEqual(c.files, ["PROMPT.md"]);
  assert.ok(!c.cwd.startsWith(dir), "temp dir outside the repo");
  assert.ok(!fs.existsSync(c.cwd), "temp dir removed");
  assert.ok(!c.prompt.includes(dir), "prompt never includes the repo path");
  assert.match(c.prompt, /Reply with one fenced code block per test file/, "submit_via_text");
  for (const flag of ["-p", "--tools", "--strict-mcp-config", "--setting-sources", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(c.argv.includes(flag), flag);
  assert.equal(c.argv[c.argv.indexOf("--tools") + 1], "");
  assert.equal(tcheck(dir, ["compose", run]).code, 0);
});

test("pi and opencode backends get the prompt on stdin, not as an argument", () => {
  const { log, env } = fakeEnv();
  const bin = tmpdir();
  for (const name of ["pi", "opencode"]) fs.copyFileSync(path.join(FAKE_BIN, "claude"), path.join(bin, name)), fs.chmodSync(path.join(bin, name), 0o755);
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  for (const backend of ["pi", "opencode"]) {
    const r = tcheck(ROOT, ["selftest", "--backend", backend, "--fixtures", "off_by_one", "--json"], { env });
    assert.equal(r.code, 0, r.stderr + r.stdout);
  }
  for (const c of calls(log)) assert.ok(!c.argv.some((a) => a.includes("\n")), "no multi-line argument");
});

test("winQuote survives the CRT argv parser for empty strings, quotes and trailing backslashes", async () => {
  const { winQuote } = await import("../dist/tcheck.mjs");
  assert.equal(winQuote(""), '""');
  assert.equal(winQuote('{"a":{}}'), '"{\\"a\\":{}}"');
  assert.equal(winQuote("C:\\dir\\"), '"C:\\dir\\\\"');
});

test("selftest runs the pipeline blind vs baseline and prints the table (fake backend)", () => {
  const { log, env } = fakeEnv();
  const r = tcheck(ROOT, ["selftest", "--backend", "claude", "--fixtures", "off_by_one", "--json"], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = r.json.results[0];
  assert.deepEqual(res.blind, { effective: 1, misguided: 0, broken: 0, neutral: 1 });
  assert.deepEqual(res.baseline, { effective: 0, misguided: 1, broken: 0, neutral: 1 });
  assert.equal(r.json.criteria.c3_fewer_misguided, true);
  assert.equal(r.json.criteria.c4_no_leaks, true);
  assert.match(r.json.table, /off_by_one\s+blind\s+1\s+0\s+0\s+1/);
  assert.match(r.json.table, /selftest: PASS/);
  assert.deepEqual(calls(log).map((c) => c.role).sort(), ["baseline", "spec", "writer"]);
  // The baseline sees the code; the blind writer never does.
  const byRole = Object.fromEntries(calls(log).map((c) => [c.role, c.prompt]));
  assert.match(byRole.baseline, /for i in range\(n\):/);
  assert.ok(!/range\(n\)/.test(byRole.writer));
});
