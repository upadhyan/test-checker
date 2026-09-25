#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/util.ts
import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== void 0) return fallback;
    throw usage(`missing file: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function toPosix(p) {
  return p.split(path.sep).join("/");
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (r.error) return { code: 127, stdout: "", stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function git(cwd, args, opts = {}) {
  const r = run("git", args, { cwd, env: opts.env, input: opts.input });
  if (r.code !== 0 && !opts.allowFail) {
    throw new TcheckError(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`, r.code === 127 ? EXIT.ENV : EXIT.COMMAND);
  }
  return r.stdout;
}
function which(name) {
  const r = isWin ? run("where", [name]) : run("/bin/sh", ["-c", `command -v ${name}`]);
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
function matchGlobs(file, globs) {
  const f = toPosix(file);
  let hit = false;
  for (const g of globs) {
    if (g.startsWith("!")) {
      if (globToRegex(g.slice(1)).test(f)) return false;
    } else if (globToRegex(g).test(f)) hit = true;
  }
  return hit;
}
var EXIT, TcheckError, usage, rejected, envMissing, isWin;
var init_util = __esm({
  "src/util.ts"() {
    "use strict";
    EXIT = { OK: 0, USAGE: 1, REJECTED: 2, ENV: 3, COMMAND: 4 };
    TcheckError = class extends Error {
      constructor(message, code = EXIT.USAGE, details) {
        super(message);
        this.code = code;
        this.details = details;
      }
    };
    usage = (m) => new TcheckError(m, EXIT.USAGE);
    rejected = (m, details) => new TcheckError(m, EXIT.REJECTED, details);
    envMissing = (m) => new TcheckError(m, EXIT.ENV);
    isWin = process.platform === "win32";
  }
});

// src/dirty.ts
import * as fs3 from "node:fs";
import * as path3 from "node:path";
function statusFiles(repo) {
  const out = repo.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFail: true });
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    files.push(e.slice(3));
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return files.filter((f) => !f.startsWith(".test-checker/"));
}
function blobShas(repo, files) {
  const existing = files.filter((f) => fs3.existsSync(path3.join(repo.root, f)) && fs3.statSync(path3.join(repo.root, f)).isFile());
  if (!existing.length) return {};
  const shas = repo.git(["hash-object", "--", ...existing]).trim().split(/\r?\n/);
  return Object.fromEntries(existing.map((f, i) => [f, shas[i]]));
}
function dirtyFiles(repo) {
  const globs = repo.config.source_globs;
  const changed = statusFiles(repo).filter((f) => matchGlobs(f, globs));
  const shas = blobShas(repo, changed);
  const verified = repo.state().verified;
  return changed.filter((f) => shas[f] && verified[f]?.sha !== shas[f]).sort();
}
function scope(repo, since = "HEAD") {
  const base = repo.commit(since);
  const globs = repo.config.source_globs;
  const tracked = repo.git(["diff", "--name-only", "-z", base, "--"]).split("\0").filter(Boolean);
  const untracked = repo.git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const files = [.../* @__PURE__ */ new Set([...tracked, ...untracked])].filter((f) => !f.startsWith(".test-checker/") && matchGlobs(f, globs)).sort();
  const shas = blobShas(repo, files);
  const verified = repo.state().verified;
  return files.filter((f) => shas[f]).map((file) => {
    const isNew = untracked.includes(file);
    let ranges;
    if (isNew) {
      const n = fs3.readFileSync(path3.join(repo.root, file), "utf8").split("\n").length;
      ranges = [[1, n]];
    } else ranges = hunks(repo.git(["diff", "-U0", base, "--", file]));
    return { file, ranges, verified: verified[file]?.sha === shas[file], ...isNew ? { untracked: true } : {} };
  });
}
function hunks(diff) {
  const out = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = parseInt(m[1], 10);
    const len = m[2] === void 0 ? 1 : parseInt(m[2], 10);
    out.push(len === 0 ? [Math.max(start, 1), Math.max(start, 1)] : [start, start + len - 1]);
  }
  return out;
}
function waive(repo, paths, reason) {
  if (!reason) throw usage("waive needs --reason");
  const rels = paths.map((p) => repo.rel(p));
  const shas = blobShas(repo, rels);
  const missing = rels.filter((r) => !shas[r]);
  if (missing.length) throw usage(`not a file: ${missing.join(", ")}`);
  const at = nowIso();
  repo.updateState((s) => {
    for (const r of rels) s.verified[r] = { sha: shas[r], run: null, at, waived: reason };
  });
  repo.ledger("waived", { files: rels, reason });
  return rels;
}
var init_dirty = __esm({
  "src/dirty.ts"() {
    "use strict";
    init_util();
  }
});

// src/status.ts
var status_exports = {};
__export(status_exports, {
  status: () => status
});
function status(repo) {
  const dirty = dirtyFiles(repo);
  const data = { gate: repo.config.gate, dirty_files: dirty, open_runs: [], unresolved_verdicts: [] };
  const human = [`gate: ${data.gate}`, `dirty: ${dirty.length ? dirty.join(", ") : "none"}`].join("\n");
  return { data, human };
}
var init_status = __esm({
  "src/status.ts"() {
    "use strict";
    init_dirty();
  }
});

// src/commands.ts
var commands_exports = {};
var init_commands = __esm({
  "src/commands.ts"() {
    "use strict";
  }
});

// src/cli.ts
init_util();
import * as fs6 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/repo.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import { fileURLToPath } from "node:url";

// src/yaml.ts
var YamlError = class extends Error {
};
function parseYaml(src) {
  const lines = [];
  src.replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
    const text = stripComment(raw).trimEnd();
    if (text.trim() === "" || text.trim() === "---") return;
    lines.push({ indent: raw.length - raw.trimStart().length, text: text.trim(), no: i + 1 });
  });
  const rawLines = src.replace(/\r\n?/g, "\n").split("\n");
  let pos = 0;
  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    return lines[pos].text.startsWith("- ") || lines[pos].text === "-" ? parseSeq(lines[pos].indent) : parseMap(lines[pos].indent);
  }
  function parseSeq(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith("- ") || lines[pos].text === "-")) {
      const line = lines[pos];
      const rest = line.text === "-" ? "" : line.text.slice(2).trim();
      pos++;
      if (rest === "") {
        out.push(pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null);
      } else if (isMapEntry(rest)) {
        const childIndent = indent + 2;
        lines.splice(pos, 0, { indent: childIndent, text: rest, no: line.no });
        out.push(parseMap(childIndent));
      } else out.push(scalar(rest, line.no));
    }
    return out;
  }
  function parseMap(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      if (line.text.startsWith("- ")) throw new YamlError(`line ${line.no}: unexpected sequence item`);
      const m = splitKey(line.text);
      if (!m) throw new YamlError(`line ${line.no}: expected "key: value"`);
      const [key, rest] = m;
      pos++;
      if (rest === "|" || rest === ">" || /^[|>][-+]?$/.test(rest)) {
        out[key] = blockScalar(line, rest[0] === ">");
      } else if (rest === "") {
        if (pos < lines.length && lines[pos].indent > indent) out[key] = parseBlock(lines[pos].indent);
        else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("- ")) out[key] = parseSeq(indent);
        else out[key] = null;
      } else out[key] = scalar(rest, line.no);
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError(`line ${lines[pos].no}: bad indentation`);
    return out;
  }
  function blockScalar(header, fold) {
    const body = [];
    let i = header.no;
    let blockIndent = -1;
    while (i < rawLines.length) {
      const raw = rawLines[i];
      if (raw.trim() === "") {
        body.push("");
        i++;
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (blockIndent < 0) blockIndent = ind;
      if (ind < blockIndent || ind <= header.indent) break;
      body.push(raw.slice(blockIndent));
      i++;
    }
    while (pos < lines.length && lines[pos].no <= i) pos++;
    while (body.length && body[body.length - 1] === "") body.pop();
    return (fold ? body.join(" ").replace(/ {2,}/g, " ") : body.join("\n")) + "\n";
  }
  const result = parseBlock(0);
  if (pos < lines.length) throw new YamlError(`line ${lines[pos].no}: unexpected content`);
  return result ?? {};
}
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}
function isMapEntry(s) {
  return splitKey(s) !== null && !/^["'[{]/.test(s);
}
function splitKey(s) {
  if (s[0] === '"' || s[0] === "'") {
    const end = s.indexOf(s[0], 1);
    if (end > 0 && s[end + 1] === ":") return [s.slice(1, end), s.slice(end + 2).trim()];
    return null;
  }
  const m = /^([^:[\]{}]+?):(?:\s+(.*))?$/.exec(s);
  return m ? [m[1].trim(), (m[2] ?? "").trim()] : null;
}
function scalar(s, no) {
  if (s.startsWith("[") || s.startsWith("{")) {
    const [v, rest] = flow(s, 0, no);
    if (s.slice(rest).trim()) throw new YamlError(`line ${no}: trailing content after flow value`);
    return v;
  }
  return plain(s, no);
}
function plain(s, no) {
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlError(`line ${no}: bad double-quoted string`);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(`line ${no}: bad single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}
function flow(s, i, no) {
  const skip = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  skip();
  if (s[i] === "[" || s[i] === "{") {
    const isMap = s[i] === "{";
    const close = isMap ? "}" : "]";
    i++;
    const arr = [];
    const obj = {};
    skip();
    if (s[i] === close) return [isMap ? obj : arr, i + 1];
    for (; ; ) {
      if (isMap) {
        const [k, j2] = flowScalar(s, i, ":", no);
        i = j2 + 1;
        const [v, j22] = flow(s, i, no);
        obj[k] = v;
        i = j22;
      } else {
        const [v, j2] = flow(s, i, no);
        arr.push(v);
        i = j2;
      }
      skip();
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === close) return [isMap ? obj : arr, i + 1];
      throw new YamlError(`line ${no}: bad flow collection`);
    }
  }
  const [raw, j] = flowScalar(s, i, ",]}", no);
  return [plain(raw, no), j];
}
function flowScalar(s, i, stops, no) {
  while (/\s/.test(s[i] ?? "")) i++;
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i];
    let j2 = i + 1;
    while (j2 < s.length && s[j2] !== q) j2 += s[j2] === "\\" && q === '"' ? 2 : 1;
    if (j2 >= s.length) throw new YamlError(`line ${no}: unterminated string`);
    const raw = s.slice(i, j2 + 1);
    return [stops === ":" ? String(plain(raw, no)) : raw, j2 + 1];
  }
  let j = i;
  while (j < s.length && !stops.includes(s[j])) j++;
  return [s.slice(i, j).trim(), j];
}

// src/schema.ts
function validate(schema, value, at = "$") {
  const errs = [];
  if (schema.const !== void 0 && value !== schema.const) errs.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) {
      errs.push(`${at}: expected ${types.join(" or ")}, got ${typeName(value)}`);
      return errs;
    }
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: must match /${schema.pattern}/`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== void 0 && value < schema.minimum) errs.push(`${at}: must be \u2265 ${schema.minimum}`);
    if (schema.maximum !== void 0 && value > schema.maximum) errs.push(`${at}: must be \u2264 ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== void 0 && value.length < schema.minItems) errs.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  } else if (value !== null && typeof value === "object") {
    const obj = value;
    for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${at}: missing required "${r}"`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unknown property "${k}"`);
    }
  }
  return errs;
}
function isType(v, t) {
  switch (t) {
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number";
    default:
      return typeof v === t;
  }
}
function typeName(v) {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

// src/repo.ts
init_util();
function pluginRoot() {
  const here = path2.dirname(fileURLToPath(import.meta.url));
  return path2.dirname(here);
}
var enginePath = () => path2.join(pluginRoot(), "dist", "tcheck.mjs");
var STATE_DIR = ".test-checker";
var IGNORED = ["runs/", "bundles/", "payloads/", "generated/", "worktrees/"];
function findRoot(opts = {}) {
  if (opts.root) return path2.resolve(opts.root);
  if (process.env.CLAUDE_PROJECT_DIR && fs2.existsSync(process.env.CLAUDE_PROJECT_DIR)) return path2.resolve(process.env.CLAUDE_PROJECT_DIR);
  let dir = path2.resolve(opts.cwd ?? process.cwd());
  for (; ; ) {
    if (fs2.existsSync(path2.join(dir, STATE_DIR, "config.yaml"))) return dir;
    const up = path2.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (opts.gitFallback === false) return null;
  const r = run("git", ["rev-parse", "--show-toplevel"], { cwd: opts.cwd ?? process.cwd() });
  return r.code === 0 ? path2.resolve(r.stdout.trim()) : null;
}
function configSchema() {
  return readJson(path2.join(pluginRoot(), "skills", "verify-tests", "references", "config.schema.json"));
}
function parseConfig(text, where = "config.yaml") {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw rejected(`${where}: ${e instanceof YamlError ? e.message : String(e)}`);
  }
  const errs = validate(configSchema(), raw);
  if (errs.length) throw rejected(`${where} is invalid:
  ${errs.join("\n  ")}`, errs);
  return withDefaults(raw);
}
function withDefaults(c) {
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
      api: { provider: "anthropic", model: null, key_env: "ANTHROPIC_API_KEY", ...c.blind?.api }
    },
    gate: c.gate ?? "warn",
    protect: c.protect ?? [],
    env_passthrough: c.env_passthrough ?? [],
    mutation: { max_mutants_per_target: 20, ...c.mutation },
    leak: { shingle_threshold: 0.25, min_line_length: 12, ...c.leak },
    repair_error_patterns: c.repair_error_patterns ?? null
  };
}
var Repo = class _Repo {
  constructor(root) {
    this.root = root;
    this.dir = path2.join(root, STATE_DIR);
  }
  dir;
  _config;
  static open(opts = {}) {
    const root = findRoot({ root: opts.root });
    if (!root) throw envMissing("not inside a git repository (use --root)");
    const repo = new _Repo(root);
    if (opts.requireConfig !== false && !fs2.existsSync(repo.configPath)) {
      throw new TcheckError(`no ${STATE_DIR}/config.yaml in ${root}. Run \`tcheck init\` or the test-checker-setup skill.`, EXIT.USAGE);
    }
    return repo;
  }
  p(...parts) {
    return path2.join(this.dir, ...parts);
  }
  get configPath() {
    return this.p("config.yaml");
  }
  get config() {
    if (!this._config) this._config = parseConfig(fs2.readFileSync(this.configPath, "utf8"), path2.join(STATE_DIR, "config.yaml"));
    return this._config;
  }
  hasConfig() {
    return fs2.existsSync(this.configPath);
  }
  // ---- ledger (engine-spec §10) ----
  ledger(type, fields = {}) {
    fs2.mkdirSync(this.dir, { recursive: true });
    const { run: runId, ...rest } = fields;
    const entry = { ts: nowIso(), ...runId ? { run: runId } : {}, type, ...rest };
    fs2.appendFileSync(this.p("ledger.jsonl"), JSON.stringify(entry) + "\n");
  }
  readLedger() {
    const f = this.p("ledger.jsonl");
    if (!fs2.existsSync(f)) return [];
    return fs2.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }
  // ---- state.json ----
  state() {
    const s = readJson(this.p("state.json"), {});
    return { verified: {}, protected: {}, quarantined: [], ...s };
  }
  updateState(fn) {
    const s = this.state();
    fn(s);
    writeJson(this.p("state.json"), s);
    return s;
  }
  git(args, opts = {}) {
    return git(this.root, args, opts);
  }
  /** Resolve a revision to a full commit sha. */
  commit(rev) {
    const r = run("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: this.root });
    if (r.code !== 0) throw new TcheckError(`unknown revision: ${rev}`, EXIT.USAGE);
    return r.stdout.trim();
  }
  rel(p) {
    return path2.relative(this.root, path2.resolve(this.root, p)).split(path2.sep).join("/");
  }
};

// src/env.ts
import * as fs4 from "node:fs";
import * as path4 from "node:path";
init_dirty();
init_util();
var HARNESSES = ["claude-code", "cowork", "codex", "opencode", "pi", "unknown"];
function detectHarness(flag, env = process.env) {
  const explicit = flag ?? env.TCHECK_HARNESS;
  if (explicit && HARNESSES.includes(explicit)) return explicit;
  const claude = env.CLAUDECODE === "1" || !!env.CLAUDE_PLUGIN_ROOT;
  if (claude) {
    return /cowork/i.test(env.CLAUDE_CODE_ENTRYPOINT ?? "") ? "cowork" : "claude-code";
  }
  if (env.PLUGIN_ROOT || Object.keys(env).some((k) => k.startsWith("CODEX_") && k !== "CODEX_HOME")) return "codex";
  return "unknown";
}
var HEADLESS = ["claude", "codex", "opencode", "pi"];
var ISOLATION = {
  native: "strong",
  api: "strong",
  opencode: "strong",
  claude: "medium",
  codex: "medium",
  pi: "medium",
  none: "none"
};
function resolveBackend(configured, harness, apiKeyEnv) {
  if (configured && configured !== "auto") return configured;
  if (harness === "claude-code" || harness === "cowork" || harness === "opencode" || harness === "pi") return "native";
  if (harness === "codex") return "codex";
  return firstHeadless() ?? (apiKeyEnv && process.env[apiKeyEnv] ? "api" : "none");
}
function firstHeadless() {
  for (const b of HEADLESS) if (which(b)) return b;
  return null;
}
function gitVersion() {
  const r = run("git", ["--version"]);
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout);
  return r.code === 0 && m ? m[1] : null;
}
function envReport(opts) {
  const harness = detectHarness(opts.harness);
  const warnings = [];
  const gitV = gitVersion();
  if (!gitV) warnings.push("git not found on PATH");
  else if (cmpVersion(gitV, "2.30") < 0) warnings.push(`git ${gitV} is older than 2.30`);
  if (cmpVersion(process.versions.node, "20") < 0) warnings.push(`node ${process.versions.node} is older than 20`);
  const root = findRoot({ root: opts.root });
  let config = "missing";
  let gate = null;
  let dirty = null;
  let backend = resolveBackend(void 0, harness);
  let hooksSeen = false;
  if (!root) warnings.push("not inside a git repository");
  else {
    const repo = new Repo(root);
    if (repo.hasConfig()) {
      try {
        const c = repo.config;
        config = "present";
        gate = c.gate;
        backend = resolveBackend(c.blind.backend, harness, c.blind.api.key_env);
        dirty = dirtyFiles(repo).length;
      } catch (e) {
        config = "invalid";
        warnings.push(e.message);
      }
      const seen = repo.state().hooks_seen_at;
      hooksSeen = !!seen && Date.now() - Date.parse(seen) < 24 * 3600 * 1e3;
    }
  }
  if (backend === "none") warnings.push("no blind backend available: install claude, codex, opencode or pi, or configure blind.backend: api");
  const ref = path4.join(pluginRoot(), "skills", "verify-tests", "references", "harness", `${harnessRefName(harness)}.md`);
  return {
    harness,
    engine: `node "${enginePath()}"`,
    plugin_root: pluginRoot(),
    harness_reference: fs4.existsSync(ref) ? ref : path4.join(path4.dirname(ref), "generic.md"),
    node: process.versions.node,
    git: gitV ?? "missing",
    repo_root: root,
    config,
    blind_backend: backend,
    blind_isolation: ISOLATION[backend],
    hooks_seen: hooksSeen,
    gate,
    dirty_files: dirty,
    warnings
  };
}
function harnessRefName(h) {
  return h === "cowork" ? "claude-code" : h === "unknown" ? "generic" : h;
}
function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// src/init.ts
import * as fs5 from "node:fs";
import * as path5 from "node:path";
init_util();
var ALIASES = {
  py: "python",
  python3: "python",
  ts: "typescript",
  js: "typescript",
  javascript: "typescript",
  golang: "go",
  kotlin: "java",
  scala: "java",
  rs: "rust"
};
function detectLanguage(root) {
  const has = (f) => fs5.existsSync(path5.join(root, f));
  if (has("pyproject.toml") || has("setup.py") || has("setup.cfg") || has("requirements.txt")) return "python";
  if (has("go.mod")) return "go";
  if (has("Cargo.toml")) return "rust";
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) return "java";
  if (has("package.json")) return "typescript";
  return null;
}
function init(repo, opts) {
  if (repo.hasConfig() && !opts.force) {
    throw new TcheckError(`${repo.rel(repo.configPath)} already exists (use --force to overwrite)`, EXIT.USAGE);
  }
  const wanted = (opts.language ?? detectLanguage(repo.root) ?? "python").toLowerCase();
  const lang = ALIASES[wanted] ?? wanted;
  const examples = path5.join(pluginRoot(), "examples");
  const exact = path5.join(examples, `config.${lang}.yaml`);
  const source = fs5.existsSync(exact) ? exact : path5.join(examples, "config.python.yaml");
  let text = fs5.readFileSync(source, "utf8");
  const warnings = [];
  if (!fs5.existsSync(exact)) warnings.push(`no example for "${wanted}"; started from the Python example. Edit commands and globs.`);
  if (opts.language && wanted !== lang) warnings.push(`using the ${lang} example for "${wanted}"`);
  if (opts.language) text = text.replace(/^language: .*$/m, `language: ${opts.language}`);
  if (opts.framework) text = text.replace(/^framework: .*$/m, `framework: ${JSON.stringify(opts.framework)}`);
  parseConfig(text, "generated config");
  writeText(repo.configPath, text);
  writeText(repo.p(".gitignore"), IGNORED.join("\n") + "\n");
  repo.ledger("initialized", { language: opts.language ?? lang, example: path5.basename(source) });
  return { config: repo.rel(repo.configPath), example: path5.basename(source), warnings };
}

// src/cli.ts
init_dirty();

// src/lib.ts
init_util();

// src/cli.ts
var MULTI = /* @__PURE__ */ new Set(["existing", "tests", "fixtures", "use"]);
var BOOL = /* @__PURE__ */ new Set(["json", "quiet", "force", "keep", "all-accepted", "include-neutral", "help"]);
function parseArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") {
      a._.push(...argv.slice(i + 1));
      break;
    }
    if (t.startsWith("--")) {
      let [k, v] = t.slice(2).split(/=(.*)/s, 2);
      if (BOOL.has(k)) a.flags[k] = true;
      else if (MULTI.has(k)) {
        const vals = v !== void 0 ? [v] : [];
        while (v === void 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
        a.flags[k] = [...a.flags[k] ?? [], ...vals];
      } else {
        if (v === void 0) {
          if (i + 1 >= argv.length) throw usage(`--${k} needs a value`);
          v = argv[++i];
        }
        a.flags[k] = v;
      }
    } else a._.push(t);
  }
  return a;
}
var str = (a, k) => typeof a.flags[k] === "string" ? a.flags[k] : void 0;
var list = (a, k) => Array.isArray(a.flags[k]) ? a.flags[k] : typeof a.flags[k] === "string" ? [a.flags[k]] : [];
var bool = (a, k) => a.flags[k] === true;
var repoOf = (a, requireConfig = true) => Repo.open({ root: str(a, "root"), requireConfig });
var COMMANDS = {
  env: (a) => {
    const r = envReport({ root: str(a, "root"), harness: str(a, "harness") });
    return { data: r, human: Object.entries(r).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") || "-" : v ?? "-"}`).join("\n") };
  },
  init: (a) => {
    const r = init(repoOf(a, false), { language: str(a, "language"), framework: str(a, "framework"), force: bool(a, "force") });
    return { data: r, human: [`Wrote ${r.config} from examples/${r.example}.`, ...r.warnings.map((w) => `warning: ${w}`), "Next: edit it, then run `tcheck doctor`."].join("\n") };
  },
  status: async (a) => (await Promise.resolve().then(() => (init_status(), status_exports))).status(repoOf(a)),
  scope: (a) => {
    const r = scope(repoOf(a), str(a, "since"));
    return { data: r, human: r.length ? r.map((e) => `${e.file} ${e.ranges.map(([x, y]) => `${x}-${y}`).join(",")}${e.verified ? " (verified)" : ""}`).join("\n") : "No changed source files." };
  },
  waive: (a) => {
    const files = waive(repoOf(a), a._.slice(1), str(a, "reason") ?? "");
    return { data: { waived: files }, human: `Waived ${files.length} file(s).` };
  }
};
function register(name, h) {
  COMMANDS[name] = h;
}
var HELP = `tcheck \u2014 test-checker engine

Usage: tcheck <command> [args] [--json] [--root DIR] [--harness NAME] [--quiet]

Setup:      env | init | doctor | status | scope | waive
Run:        run start | target add | context set | spec prompt|save|show|edit
            bundle build|emit | blind-run | ingest | compose | exec | classify
            adjudicate queue|prompt|save|override | report | promote
Integrate:  hook <event> | mcp | selftest

See docs/engine-spec.md \xA75.`;
function commandKey(a) {
  const [first, second] = a._;
  if (first && second && COMMANDS[`${first} ${second}`]) return [`${first} ${second}`, { ...a, _: a._.slice(1) }];
  return [first, a];
}
async function main(argv) {
  let json = false;
  try {
    const a = parseArgs(argv);
    json = bool(a, "json");
    if (!a._.length || bool(a, "help")) {
      process.stdout.write(HELP + "\n");
      return a._.length || bool(a, "help") ? EXIT.OK : EXIT.USAGE;
    }
    await loadCommands();
    const [key, args] = commandKey(a);
    const h = COMMANDS[key];
    if (!h) throw usage(`unknown command: ${a._.slice(0, 2).join(" ")}

${HELP}`);
    const out = await h(args);
    if (out.data !== void 0 || out.human !== void 0) {
      if (json) process.stdout.write(JSON.stringify(out.data, null, 2) + "\n");
      else if (!bool(a, "quiet") && out.human !== void 0) process.stdout.write(out.human.endsWith("\n") ? out.human : out.human + "\n");
    }
    return out.code ?? EXIT.OK;
  } catch (e) {
    const code = e instanceof TcheckError ? e.code : EXIT.COMMAND;
    const msg = e instanceof TcheckError ? e.message : `internal error: ${e?.stack ?? e}`;
    if (json) process.stdout.write(JSON.stringify({ error: msg, code, details: e?.details }, null, 2) + "\n");
    process.stderr.write(`tcheck: ${msg}
`);
    return code;
  }
}
async function loadCommands() {
  await Promise.resolve().then(() => (init_commands(), commands_exports));
}
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs6.realpathSync(process.argv[1]) === fs6.realpathSync(fileURLToPath2(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
export {
  Repo,
  bool,
  detectHarness,
  dirtyFiles,
  findRoot,
  globToRegex,
  list,
  main,
  matchGlobs,
  parseArgs,
  parseConfig,
  parseYaml,
  pluginRoot,
  register,
  resolveBackend,
  str,
  validate
};
