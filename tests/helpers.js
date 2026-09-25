import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Run the engine; returns {code, stdout, stderr, json}. */
export function tcheck(cwd, args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [ENGINE, ...args], { cwd, encoding: "utf8", input: opts.input, env });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
