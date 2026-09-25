import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtureRepo } from "../dist/tcheck.mjs";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ENGINE = path.join(ROOT, "dist", "tcheck.mjs");

export function tmpdir(prefix = "tcheck-test-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** A git repo with one commit containing `files`. */
export function scratchRepo(files = { "README.md": "hi\n" }) {
  const dir = tmpdir();
  git(dir, "init", "-q", "-b", "main");
  writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

export function writeFiles(dir, files) {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
}

export const VENV_BIN = path.join(ROOT, ".venv", "bin");
/** Python fixtures run `python -m pytest`; the repo venv provides both. */
export const PATH_WITH_VENV = fs.existsSync(VENV_BIN) ? `${VENV_BIN}${path.delimiter}${process.env.PATH}` : process.env.PATH;

/** Run the engine; returns {code, stdout, stderr, json}. */
export function tcheck(cwd, args, opts = {}) {
  const env = { ...process.env, PATH: PATH_WITH_VENV, ...opts.env };
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [ENGINE, ...args], { cwd, encoding: "utf8", input: opts.input, env });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

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

export function setConfig(dir, edit) {
  const f = path.join(dir, ".test-checker/config.yaml");
  fs.writeFileSync(f, edit(fs.readFileSync(f, "utf8")));
}
