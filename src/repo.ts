import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, YamlError } from "./yaml";
import { validate } from "./schema";
import { EXIT, TcheckError, envMissing, git, nowIso, readJson, rejected, run, writeJson } from "./util";

/** The plugin root: the directory above dist/ (or src/ when run unbundled). */
export function pluginRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.dirname(here);
}

export const enginePath = () => path.join(pluginRoot(), "dist", "tcheck.mjs");

export const STATE_DIR = ".test-checker";
export const IGNORED = ["runs/", "bundles/", "payloads/", "generated/", "worktrees/"];

/** engine-spec §3 root discovery. `gitFallback: false` keeps hooks fast. */
export function findRoot(opts: { root?: string; cwd?: string; gitFallback?: boolean } = {}): string | null {
  if (opts.root) return path.resolve(opts.root);
  if (process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR)) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  let dir = path.resolve(opts.cwd ?? process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, STATE_DIR, "config.yaml"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (opts.gitFallback === false) return null;
  const r = run("git", ["rev-parse", "--show-toplevel"], { cwd: opts.cwd ?? process.cwd() });
  return r.code === 0 ? path.resolve(r.stdout.trim()) : null;
}

export interface Config {
  version: 1;
  language: string;
  language_tag: string;
  framework: string;
  source_globs: string[];
  test_dir: string;
  test_file_pattern: string;
  promote_dir?: string;
  commands: { setup?: string | null; compile?: string | null; run: string; mutate?: string | null };
  timeouts: { per_test_seconds: number; per_command_seconds: number };
  flake_reruns: number;
  refine_rounds: number;
  spec: { prompt: "advanced" | "base"; variant: "auto" | "reasoning" | "scaffold"; source: "fixed" | "buggy" };
  blind: { backend: string; model: string | null; api: { provider: "anthropic" | "openai"; model: string | null; key_env: string } };
  gate: "off" | "warn" | "block";
  protect: string[];
  env_passthrough: string[];
  mutation: { max_mutants_per_target: number };
  leak: { shingle_threshold: number; min_line_length: number };
  repair_error_patterns: string[] | null;
}

export function configSchema(): any {
  return readJson(path.join(pluginRoot(), "skills", "test-checker", "references", "config.schema.json"));
}

/** Parse + validate raw config text; returns the config with defaults applied. */
export function parseConfig(text: string, where = "config.yaml"): Config {
  let raw: any;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw rejected(`${where}: ${e instanceof YamlError ? e.message : String(e)}`);
  }
  const errs = validate(configSchema(), raw);
  if (errs.length) throw rejected(`${where} is invalid:\n  ${errs.join("\n  ")}`, errs);
  return withDefaults(raw);
}

function withDefaults(c: any): Config {
  return {
    ...c,
    language_tag: c.language_tag ?? c.language,
    commands: { setup: null, compile: null, mutate: null, ...c.commands },
    timeouts: { per_test_seconds: 30, per_command_seconds: 600, ...c.timeouts },
    flake_reruns: c.flake_reruns ?? 3,
    refine_rounds: c.refine_rounds ?? 3,
    spec: { prompt: "advanced", variant: "auto", source: "fixed", ...c.spec },
    blind: {
      backend: "auto",
      model: null,
      ...c.blind,
      api: { provider: "anthropic", model: null, key_env: "ANTHROPIC_API_KEY", ...c.blind?.api },
    },
    gate: c.gate ?? "warn",
    protect: c.protect ?? [],
    env_passthrough: c.env_passthrough ?? [],
    mutation: { max_mutants_per_target: 20, ...c.mutation },
    leak: { shingle_threshold: 0.25, min_line_length: 12, ...c.leak },
    repair_error_patterns: c.repair_error_patterns ?? null,
  };
}

export interface State {
  verified: Record<string, { sha: string; run: string | null; at: string; waived?: string }>;
  protected: Record<string, { test_ids: string[]; run: string }>;
  quarantined: string[];
  hooks_seen_at?: string;
}

/** A repo with test-checker state. Every state change goes through here (invariant 5). */
export class Repo {
  readonly dir: string;
  private _config?: Config;

  constructor(public root: string) {
    this.dir = path.join(root, STATE_DIR);
  }

  static open(opts: { root?: string; requireConfig?: boolean } = {}): Repo {
    const root = findRoot({ root: opts.root });
    if (!root) throw envMissing("not inside a git repository (use --root)");
    const repo = new Repo(root);
    if (opts.requireConfig !== false && !fs.existsSync(repo.configPath)) {
      throw new TcheckError(`no ${STATE_DIR}/config.yaml in ${root}. Run \`tcheck init\` or the test-checker-setup skill.`, EXIT.USAGE);
    }
    return repo;
  }

  p(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  get configPath(): string {
    return this.p("config.yaml");
  }

  get config(): Config {
    if (!this._config) this._config = parseConfig(fs.readFileSync(this.configPath, "utf8"), path.join(STATE_DIR, "config.yaml"));
    return this._config;
  }

  hasConfig(): boolean {
    return fs.existsSync(this.configPath);
  }

  // ---- ledger (engine-spec §10) ----
  ledger(type: string, fields: Record<string, unknown> = {}): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const { run: runId, ...rest } = fields;
    const entry = { ts: nowIso(), ...(runId ? { run: runId } : {}), type, ...rest };
    fs.appendFileSync(this.p("ledger.jsonl"), JSON.stringify(entry) + "\n");
  }

  readLedger(): any[] {
    const f = this.p("ledger.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  // ---- state.json ----
  state(): State {
    const s = readJson<Partial<State>>(this.p("state.json"), {});
    return { verified: {}, protected: {}, quarantined: [], ...s };
  }

  updateState(fn: (s: State) => void): State {
    const s = this.state();
    fn(s);
    writeJson(this.p("state.json"), s);
    return s;
  }

  git(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; allowFail?: boolean } = {}): string {
    return git(this.root, args, opts);
  }

  /** Resolve a revision to a full commit sha. */
  commit(rev: string): string {
    const r = run("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: this.root });
    if (r.code !== 0) throw new TcheckError(`unknown revision: ${rev}`, EXIT.USAGE);
    return r.stdout.trim();
  }

  rel(p: string): string {
    return path.relative(this.root, path.resolve(this.root, p)).split(path.sep).join("/");
  }
}
