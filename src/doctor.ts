import * as fs from "node:fs";
import * as path from "node:path";
import { Repo } from "./repo";
import { commandEnv, fillCommand } from "./exec";
import { readJUnitPath } from "./junit";
import { ensureWorktree, expandPath, packagePath, snapshotWorktree } from "./run";
import { EXIT, TcheckError, matchGlobs, randHex, shell } from "./util";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
}

interface Template {
  match: RegExp;
  files: (ctx: { name: (n: number) => string; pkg: string; javaPkg: string }) => { n: number; content: string }[];
}

const cls = (file: string) => path.basename(file).replace(/\..*$/, "");

/** Minimal pass/fail tests per framework (engine-spec §5 "doctor trivial tests"). */
const TEMPLATES: Template[] = [
  { match: /pytest/i, files: () => [{ n: 1, content: "def test_tcheck_doctor_pass():\n    assert 1 + 1 == 2\n\n\ndef test_tcheck_doctor_fail():\n    assert 1 + 1 == 3\n" }] },
  {
    match: /unittest/i,
    files: () => [{ n: 1, content: "import unittest\n\n\nclass TCheckDoctor(unittest.TestCase):\n    def test_pass(self):\n        self.assertEqual(1 + 1, 2)\n\n    def test_fail(self):\n        self.assertEqual(1 + 1, 3)\n" }],
  },
  { match: /vitest/i, files: () => [{ n: 1, content: "import { test, expect } from 'vitest';\n\ntest('tcheck doctor pass', () => { expect(1 + 1).toBe(2); });\ntest('tcheck doctor fail', () => { expect(1 + 1).toBe(3); });\n" }] },
  { match: /jest/i, files: () => [{ n: 1, content: "test('tcheck doctor pass', () => { expect(1 + 1).toBe(2); });\ntest('tcheck doctor fail', () => { expect(1 + 1).toBe(3); });\n" }] },
  {
    match: /\bgo\b|go test|gotestsum/i,
    files: ({ pkg }) => [{ n: 1, content: `package ${pkg}\n\nimport "testing"\n\nfunc TestTCheckDoctorPass(t *testing.T) {}\n\nfunc TestTCheckDoctorFail(t *testing.T) { t.Fatal("intentional failure") }\n` }],
  },
  {
    match: /junit\s*5|jupiter/i,
    files: ({ name, javaPkg }) => [
      {
        n: 1,
        content: `${javaPkg ? `package ${javaPkg};\n\n` : ""}import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass ${cls(name(1))} {\n  @Test void pass() { assertEquals(2, 1 + 1); }\n  @Test void fail() { assertEquals(3, 1 + 1); }\n}\n`,
      },
    ],
  },
  {
    match: /junit/i,
    files: ({ name, javaPkg }) => [
      {
        n: 1,
        content: `${javaPkg ? `package ${javaPkg};\n\n` : ""}import org.junit.Test;\nimport static org.junit.Assert.assertEquals;\n\npublic class ${cls(name(1))} {\n  @Test public void pass() { assertEquals(2, 1 + 1); }\n  @Test public void fail() { assertEquals(3, 1 + 1); }\n}\n`,
      },
    ],
  },
  { match: /cargo|nextest|rust/i, files: () => [{ n: 1, content: "#[test]\nfn tcheck_doctor_pass() { assert_eq!(2, 1 + 1); }\n\n#[test]\nfn tcheck_doctor_fail() { assert_eq!(3, 1 + 1); }\n" }] },
  {
    match: /xunit|dotnet/i,
    files: ({ name }) => [{ n: 1, content: `using Xunit;\n\npublic class ${cls(name(1))}\n{\n    [Fact] public void Pass() { Assert.Equal(2, 1 + 1); }\n    [Fact] public void Fail() { Assert.Equal(3, 1 + 1); }\n}\n` }],
  },
];

export async function doctor(repo: Repo, opts: { use?: string[]; log?: (s: string) => void }) {
  const checks: Check[] = [];
  const log = opts.log ?? ((s: string) => process.stderr.write(s + "\n"));
  let cfg;
  try {
    cfg = repo.config;
    checks.push({ name: "config", ok: true, detail: `valid against config.schema.json` });
  } catch (e: any) {
    checks.push({ name: "config", ok: false, detail: e.message, fix: "Fix the fields listed above; see references/config-reference.md." });
    return { ok: false, checks, code: EXIT.REJECTED };
  }

  // A stand-in target so path placeholders ({pkg_dir}, {package_path}, …) resolve like a real run.
  const src = repo
    .git(["ls-files", "-z"], { allowFail: true })
    .split("\0")
    .find((f) => f && matchGlobs(f, cfg.source_globs));
  if (!src) checks.push({ name: "source_globs", ok: false, detail: `no tracked file matches ${JSON.stringify(cfg.source_globs)}`, fix: "Point source_globs at the project's source files." });
  else checks.push({ name: "source_globs", ok: true, detail: `e.g. ${src}` });
  const stand = { id: "tcheck-doctor", file: src ?? "doctor", symbol: "doctor" };
  const testDir = expandPath(cfg.test_dir, stand);
  const name = (n: number) => path.posix.join(testDir, expandPath(cfg.test_file_pattern, stand, n));

  let files: { path: string; content: string }[];
  if (opts.use?.length) {
    files = opts.use.map((p) => {
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) throw new TcheckError(`--use file not found: ${p}`, EXIT.USAGE);
      return { path: path.posix.join(testDir, path.basename(abs)), content: fs.readFileSync(abs, "utf8") };
    });
  } else {
    const tpl = TEMPLATES.find((t) => t.match.test(cfg.framework));
    if (!tpl) {
      const a = name(1);
      const b = name(2);
      throw new TcheckError(
        `doctor has no template for framework "${cfg.framework}". Write two trivial ${cfg.language} tests, one that passes and one that fails, ` +
          `for example at ${a} and ${b}, then run: tcheck doctor --use ${a} ${b}`,
        EXIT.USAGE,
      );
    }
    const pkgDir = src ? path.posix.dirname(src) : ".";
    const goPkg = src && fs.existsSync(path.join(repo.root, src)) ? /^package\s+(\w+)/m.exec(fs.readFileSync(path.join(repo.root, src), "utf8"))?.[1] : undefined;
    files = tpl.files({ name, pkg: goPkg ?? path.posix.basename(pkgDir), javaPkg: packagePath(stand.file).replace(/\//g, ".") }).map((f) => ({ path: name(f.n), content: f.content }));
  }

  const snapId = `doctor-${randHex(6)}`;
  const commit = snapshotWorktree(repo, snapId);
  const wt = ensureWorktree(repo, commit);
  try {
    for (const f of files) {
      const dst = path.join(wt.dir, f.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, f.content);
      wt.meta.composed.push(f.path);
    }
    wt.saveMeta();
    checks.push({ name: "test files", ok: true, detail: files.map((f) => f.path).join(", ") });
    const env = commandEnv(cfg);
    const timeout = cfg.timeouts.per_command_seconds;
    const junitDir = repo.p("runs", "_doctor");
    fs.rmSync(junitDir, { recursive: true, force: true });
    fs.mkdirSync(junitDir, { recursive: true });
    const junit = path.join(junitDir, "junit.xml");
    const vars = { files: files.map((f) => f.path).join(" "), junit, test_dir: testDir, root: wt.dir };
    for (const step of ["setup", "compile"] as const) {
      const cmd = cfg.commands[step];
      if (!cmd) continue;
      log(`doctor: ${step}: ${cmd}`);
      const r = await shell(fillCommand(cmd, vars), { cwd: wt.dir, env, timeoutSec: timeout });
      const ok = r.code === 0;
      checks.push({ name: `commands.${step}`, ok, detail: ok ? "ok" : `exit ${r.code}\n${(r.stdout + r.stderr).slice(-1500)}`, fix: ok ? undefined : hint(r.code, cfg.framework, step) });
      if (!ok) return { ok: false, checks, code: EXIT.COMMAND };
      if (step === "setup") {
        wt.meta.setup_done = true;
        wt.saveMeta();
      }
    }
    log(`doctor: run: ${cfg.commands.run}`);
    const r = await shell(fillCommand(cfg.commands.run, vars), { cwd: wt.dir, env, timeoutSec: timeout });
    const cases = readJUnitPath(junitDir);
    const output = (r.stdout + r.stderr).slice(-1500);
    checks.push({ name: "commands.run", ok: r.code !== 127 && !r.timedOut, detail: `exit ${r.code}${r.timedOut ? " (timeout)" : ""}`, fix: r.code === 127 ? hint(127, cfg.framework, "run") : undefined });
    if (!cases.length) {
      checks.push({
        name: "junit",
        ok: false,
        detail: `no JUnit XML test cases at {junit}.\n${output}`,
        fix: `commands.run must write JUnit XML to {junit} (a file, or a directory of XML files) and run only {files}. ${hint(r.code, cfg.framework, "run")}`,
      });
      return { ok: false, checks, code: EXIT.COMMAND };
    }
    const pass = cases.filter((c) => c.outcome === "pass").length;
    const fail = cases.filter((c) => c.outcome === "failure" || c.outcome === "error").length;
    const ok = pass >= 1 && fail >= 1;
    checks.push({
      name: "junit",
      ok,
      detail: `${cases.length} test case(s): ${pass} pass, ${fail} fail`,
      fix: ok ? undefined : pass === 0 ? `Nothing passed: the tests may not import or run. Output:\n${output}` : "The failing test did not fail: check that {files} is honoured and test ids are unique.",
    });
    return { ok, checks, code: ok ? EXIT.OK : EXIT.COMMAND };
  } finally {
    for (const f of wt.meta.composed) fs.rmSync(path.join(wt.dir, f), { force: true });
    repo.git(["worktree", "remove", "--force", wt.dir], { allowFail: true });
    fs.rmSync(repo.p("worktrees", "_cache", `${commit}.json`), { force: true });
    repo.git(["update-ref", "-d", `refs/tcheck/${snapId}/worktree`], { allowFail: true });
  }
}

function hint(code: number, framework: string, step: string): string {
  if (code === 127) return `A command in commands.${step} was not found on PATH. Install it or use the full path.`;
  if (/nextest/i.test(framework)) return 'cargo-nextest needs a JUnit profile: add `[profile.tcheck.junit]\\npath = "junit.xml"` to .config/nextest.toml.';
  if (/jest/i.test(framework) && !/vitest/i.test(framework)) return "jest needs the jest-junit reporter (ask the user before installing it).";
  if (/go/i.test(framework)) return "go test needs gotestsum (or go-junit-report) for JUnit output.";
  return "Run the command by hand in the repo to see what it does.";
}
