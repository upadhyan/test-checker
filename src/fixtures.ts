import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pluginRoot } from "./repo";
import { parseYaml } from "./yaml";
import { copyDir, git, usage } from "./util";

export interface Fixture {
  name: string;
  language: string;
  target: string;
  lines: [number, number];
  bug: string;
  intent: string;
  expect: { min_effective_blind: number };
  dir: string;
}

export function fixturesDir(): string {
  return path.join(pluginRoot(), "fixtures");
}

export function listFixtures(): string[] {
  const d = fixturesDir();
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, "fixture.yaml"))).sort() : [];
}

export function loadFixture(name: string): Fixture {
  const dir = path.join(fixturesDir(), name);
  if (!fs.existsSync(path.join(dir, "fixture.yaml"))) throw usage(`unknown fixture: ${name}`);
  return { ...parseYaml(fs.readFileSync(path.join(dir, "fixture.yaml"), "utf8")), dir };
}

const IDENT = { GIT_AUTHOR_NAME: "tcheck", GIT_AUTHOR_EMAIL: "tcheck@localhost", GIT_COMMITTER_NAME: "tcheck", GIT_COMMITTER_EMAIL: "tcheck@localhost" };

/**
 * engine-spec §14 step 1: a temp git repo with the buggy tree then the fixed tree as two commits,
 * and the fixture's config installed (uncommitted, like a user's local setup).
 */
export function buildFixtureRepo(name: string, dest?: string): { dir: string; buggy: string; fixed: string; fixture: Fixture } {
  const fx = loadFixture(name);
  const dir = dest ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tcheck-fx-${name}-`)));
  const env = { ...process.env, ...IDENT };
  const g = (...args: string[]) => git(dir, args, { env });
  g("init", "-q");
  copyDir(path.join(fx.dir, "buggy"), dir);
  g("add", "-A");
  g("commit", "-q", "--no-gpg-sign", "-m", "buggy");
  const buggy = g("rev-parse", "HEAD").trim();
  for (const e of fs.readdirSync(dir)) if (e !== ".git") fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  copyDir(path.join(fx.dir, "fixed"), dir);
  g("add", "-A");
  g("commit", "-q", "--no-gpg-sign", "-m", "fixed");
  const fixed = g("rev-parse", "HEAD").trim();
  fs.mkdirSync(path.join(dir, ".test-checker"), { recursive: true });
  fs.copyFileSync(path.join(fx.dir, "config.yaml"), path.join(dir, ".test-checker", "config.yaml"));
  fs.writeFileSync(path.join(dir, ".test-checker", ".gitignore"), "*\n");
  return { dir, buggy, fixed, fixture: fx };
}
