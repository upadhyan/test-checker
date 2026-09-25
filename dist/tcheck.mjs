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
import * as crypto from "node:crypto";
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function randHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
function readInput(file) {
  if (file === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(file)) throw usage(`file not found: ${file}`);
  return fs.readFileSync(file, "utf8");
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
function gitOk(cwd, args) {
  return run("git", args, { cwd }).code === 0;
}
function shell(command, opts) {
  return new Promise((resolve3) => {
    const [sh, flag] = isWin ? ["cmd.exe", "/c"] : ["/bin/sh", "-c"];
    const child = spawn(sh, [flag, command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: !isWin,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.stdin.on("error", () => {
    });
    if (opts.input !== void 0) child.stdin.end(opts.input);
    else child.stdin.end();
    const timer = opts.timeoutSec ? setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutSec * 1e3) : void 0;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve3({ code: 127, stdout, stderr: stderr + String(e.message) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve3({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}
function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
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
function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out.sort();
}
function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
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

// src/yaml.ts
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
  let q2 = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q2) {
      if (c === "\\" && q2 === '"') i++;
      else if (c === q2) q2 = null;
    } else if (c === '"' || c === "'") q2 = c;
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
    const q2 = s[i];
    let j2 = i + 1;
    while (j2 < s.length && s[j2] !== q2) j2 += s[j2] === "\\" && q2 === '"' ? 2 : 1;
    if (j2 >= s.length) throw new YamlError(`line ${no}: unterminated string`);
    const raw = s.slice(i, j2 + 1);
    return [stops === ":" ? String(plain(raw, no)) : raw, j2 + 1];
  }
  let j = i;
  while (j < s.length && !stops.includes(s[j])) j++;
  return [s.slice(i, j).trim(), j];
}
var YamlError;
var init_yaml = __esm({
  "src/yaml.ts"() {
    "use strict";
    YamlError = class extends Error {
    };
  }
});

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
var init_schema = __esm({
  "src/schema.ts"() {
    "use strict";
  }
});

// src/repo.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import { fileURLToPath } from "node:url";
function pluginRoot() {
  const here = path2.dirname(fileURLToPath(import.meta.url));
  return path2.dirname(here);
}
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
var enginePath, STATE_DIR, IGNORED, Repo;
var init_repo = __esm({
  "src/repo.ts"() {
    "use strict";
    init_yaml();
    init_schema();
    init_util();
    enginePath = () => path2.join(pluginRoot(), "dist", "tcheck.mjs");
    STATE_DIR = ".test-checker";
    IGNORED = ["runs/", "bundles/", "payloads/", "generated/", "worktrees/"];
    Repo = class _Repo {
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
      const text = fs3.readFileSync(path3.join(repo.root, file), "utf8");
      const n = Math.max(1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
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

// src/env.ts
import * as fs4 from "node:fs";
import * as path4 from "node:path";
function detectHarness(flag, env = process.env) {
  const explicit = flag ?? env.TCHECK_HARNESS;
  if (explicit && HARNESSES.includes(explicit)) return explicit;
  const codex = !!env.PLUGIN_ROOT || Object.keys(env).some((k) => k.startsWith("CODEX_") && k !== "CODEX_HOME");
  if (env.CLAUDECODE === "1" || env.CLAUDE_PLUGIN_ROOT && !codex) {
    return /cowork/i.test(env.CLAUDE_CODE_ENTRYPOINT ?? "") ? "cowork" : "claude-code";
  }
  return codex ? "codex" : "unknown";
}
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
var HARNESSES, HEADLESS, ISOLATION;
var init_env = __esm({
  "src/env.ts"() {
    "use strict";
    init_repo();
    init_dirty();
    init_util();
    HARNESSES = ["claude-code", "cowork", "codex", "opencode", "pi", "unknown"];
    HEADLESS = ["claude", "codex", "opencode", "pi"];
    ISOLATION = {
      native: "strong",
      api: "strong",
      opencode: "strong",
      claude: "medium",
      codex: "medium",
      pi: "medium",
      none: "none"
    };
  }
});

// src/init.ts
import * as fs5 from "node:fs";
import * as path5 from "node:path";
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
var ALIASES;
var init_init = __esm({
  "src/init.ts"() {
    "use strict";
    init_repo();
    init_util();
    ALIASES = {
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
  }
});

// src/fixtures.ts
import * as fs6 from "node:fs";
import * as os from "node:os";
import * as path6 from "node:path";
function fixturesDir() {
  return path6.join(pluginRoot(), "fixtures");
}
function listFixtures() {
  const d = fixturesDir();
  return fs6.existsSync(d) ? fs6.readdirSync(d).filter((n) => fs6.existsSync(path6.join(d, n, "fixture.yaml"))).sort() : [];
}
function loadFixture(name) {
  const dir = path6.join(fixturesDir(), name);
  if (!fs6.existsSync(path6.join(dir, "fixture.yaml"))) throw usage(`unknown fixture: ${name}`);
  return { ...parseYaml(fs6.readFileSync(path6.join(dir, "fixture.yaml"), "utf8")), dir };
}
function buildFixtureRepo(name, dest) {
  const fx = loadFixture(name);
  const dir = dest ?? fs6.realpathSync(fs6.mkdtempSync(path6.join(os.tmpdir(), `tcheck-fx-${name}-`)));
  const env = { ...process.env, ...IDENT };
  const g = (...args) => git(dir, args, { env });
  g("init", "-q");
  copyDir(path6.join(fx.dir, "buggy"), dir);
  g("add", "-A");
  g("commit", "-q", "--no-gpg-sign", "-m", "buggy");
  const buggy = g("rev-parse", "HEAD").trim();
  for (const e of fs6.readdirSync(dir)) if (e !== ".git") fs6.rmSync(path6.join(dir, e), { recursive: true, force: true });
  copyDir(path6.join(fx.dir, "fixed"), dir);
  g("add", "-A");
  g("commit", "-q", "--no-gpg-sign", "-m", "fixed");
  const fixed = g("rev-parse", "HEAD").trim();
  fs6.mkdirSync(path6.join(dir, ".test-checker"), { recursive: true });
  fs6.copyFileSync(path6.join(fx.dir, "config.yaml"), path6.join(dir, ".test-checker", "config.yaml"));
  fs6.writeFileSync(path6.join(dir, ".test-checker", ".gitignore"), "*\n");
  return { dir, buggy, fixed, fixture: fx };
}
var IDENT;
var init_fixtures = __esm({
  "src/fixtures.ts"() {
    "use strict";
    init_repo();
    init_yaml();
    init_util();
    IDENT = { GIT_AUTHOR_NAME: "tcheck", GIT_AUTHOR_EMAIL: "tcheck@localhost", GIT_COMMITTER_NAME: "tcheck", GIT_COMMITTER_EMAIL: "tcheck@localhost" };
  }
});

// src/junit.ts
import * as fs7 from "node:fs";
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}
function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3] ?? "");
  return out;
}
function parseJUnit(xml) {
  const cases = [];
  let cur = null;
  let child = null;
  let buf = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  for (let m; m = re.exec(xml); ) {
    if (child) buf += decode(xml.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== void 0) {
      if (child) buf += m[1];
      continue;
    }
    const [, , close, tag3, attrText, selfClose] = m;
    if (!tag3) continue;
    if (!close && tag3 === "testcase") {
      const a = attrs(attrText);
      cur = { classname: a.classname ?? "", name: a.name ?? "", outcome: "pass", ...a.file ? { file: a.file } : {} };
      if (selfClose) {
        cases.push(cur);
        cur = null;
      }
    } else if (close && tag3 === "testcase" && cur) {
      cases.push(cur);
      cur = null;
    } else if (cur && !close && (tag3 === "failure" || tag3 === "error" || tag3 === "skipped")) {
      const a = attrs(attrText);
      if (cur.outcome === "pass" || tag3 !== "skipped") cur.outcome = tag3;
      if (a.type) cur.type = a.type;
      if (a.message) cur.message = a.message;
      if (!selfClose) {
        child = tag3;
        buf = "";
      }
    } else if (close && child && tag3 === child && cur) {
      cur.text = (cur.text ? cur.text + "\n" : "") + buf.trim();
      child = null;
    }
  }
  return cases;
}
function readJUnitPath(p) {
  if (!fs7.existsSync(p)) return [];
  const files = fs7.statSync(p).isDirectory() ? listFilesRecursive(p).filter((f) => f.endsWith(".xml")) : [p];
  return files.flatMap((f) => parseJUnit(fs7.readFileSync(f, "utf8")));
}
var ENT;
var init_junit = __esm({
  "src/junit.ts"() {
    "use strict";
    init_util();
    ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  }
});

// src/leak.ts
import * as fs8 from "node:fs";
import * as path7 from "node:path";
function normalize(line) {
  return line.trim().replace(/\s+/g, " ").replace(/[\s;,]+$/, "");
}
function signatureLineCount(lines) {
  let i = 0;
  while (i < lines.length - 1 && (lines[i].trim() === "" || DECORATOR.test(lines[i]))) i++;
  let depth = 0;
  for (; i < lines.length; i++) {
    for (const c of lines[i]) {
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
    }
    if (depth <= 0) break;
  }
  i++;
  if (i < lines.length && /^\s*\{\s*$/.test(lines[i])) i++;
  return Math.min(Math.max(i, 1), lines.length);
}
function isTrivial(line) {
  const toks = line.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  return toks.every((t) => KEYWORDS.has(t));
}
function commentMask(lines) {
  const mask = [];
  let inDoc = null;
  for (const l of lines) {
    const t = l.trim();
    if (inDoc) {
      mask.push(true);
      if (t.includes(inDoc)) inDoc = null;
      continue;
    }
    const q2 = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
    if (q2) {
      mask.push(true);
      if (!(t.length >= 6 && t.slice(3).includes(q2))) inDoc = q2;
      continue;
    }
    mask.push(/^(\/\/|\/\*|\*|#(?!\[)|--|;;)/.test(t));
  }
  return mask;
}
function significantLines(t, opts = {}) {
  const minLen = opts.minLen ?? 12;
  const mask = commentMask(t.body_lines);
  return [...new Set(t.body_lines.filter((l, i) => !mask[i] && l.length >= minLen && !isTrivial(l) && !opts.common?.has(l)))];
}
function shingles(toks, k = 6) {
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i + k <= toks.length; i++) out.add(toks.slice(i, i + k).join(" "));
  return out;
}
function checkLeak(text, targets, opts = {}) {
  const threshold = opts.threshold ?? 0.25;
  const textLines = text.split(/\r?\n/).map(normalize);
  const findings = [];
  let worst = 0;
  let worstTarget;
  const textShingles = shingles(tokens(text));
  for (const t of targets) {
    for (const bl of significantLines(t, opts)) {
      textLines.forEach((tl, i) => {
        if (tl.includes(bl)) findings.push({ target: t.id, body_line: bl, text_line: i + 1, text: tl });
      });
    }
    const mask = commentMask(t.body_lines);
    const bodyShingles = shingles(tokens(t.body_lines.filter((_, i) => !mask[i]).join("\n")));
    if (bodyShingles.size) {
      let shared = 0;
      for (const s of bodyShingles) if (textShingles.has(s)) shared++;
      const ratio = shared / bodyShingles.size;
      if (ratio > worst) {
        worst = ratio;
        worstTarget = t.id;
      }
    }
  }
  return {
    passed: findings.length === 0 && worst <= threshold,
    findings,
    shingle_ratio: Math.round(worst * 1e3) / 1e3,
    ...worstTarget ? { shingle_target: worstTarget } : {}
  };
}
function redactLeaks(text, targets, opts = {}) {
  const sig = targets.flatMap((t) => significantLines(t, opts));
  return text.split(/\r?\n/).map((l) => {
    const n = normalize(l);
    return sig.some((s) => n.includes(s)) ? REDACTED : l;
  }).join("\n");
}
function formatFindings(r, where) {
  const lines = r.findings.slice(0, 20).map((f) => `  ${where}:${f.text_line}: contains body line of ${f.target}: "${f.body_line}"`);
  if (r.findings.length > 20) lines.push(`  \u2026 and ${r.findings.length - 20} more`);
  if (!r.findings.length) lines.push(`  ${where}: shares ${Math.round(r.shingle_ratio * 100)}% of ${r.shingle_target}'s 6-token shingles`);
  return lines.join("\n");
}
function commonLines(repo, runId) {
  const cache = runId ? repo.p("runs", runId, "common-lines.json") : null;
  if (cache && fs8.existsSync(cache)) return new Set(readJson(cache));
  const minLen = repo.config.leak.min_line_length;
  const files = repo.git(["ls-files", "-z"], { allowFail: true }).split("\0").filter((f) => f && matchGlobs(f, repo.config.source_globs));
  const counts2 = /* @__PURE__ */ new Map();
  for (const f of files) {
    const p = path7.join(repo.root, f);
    try {
      if (fs8.statSync(p).size > 1e6) continue;
      const seen = new Set(fs8.readFileSync(p, "utf8").split(/\r?\n/).map(normalize).filter((l) => l.length >= minLen));
      for (const l of seen) counts2.set(l, (counts2.get(l) ?? 0) + 1);
    } catch {
    }
  }
  const top = [...counts2.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 200).map(([l]) => l);
  if (cache) writeJson(cache, top);
  return new Set(top);
}
var DECORATOR, KEYWORDS, tokens, REDACTED;
var init_leak = __esm({
  "src/leak.ts"() {
    "use strict";
    init_util();
    DECORATOR = /^\s*(@|#\[|\[[A-Z]|\/\/|\/\*|\*|#(?!\[)|--|;;)/;
    KEYWORDS = new Set("else try finally end return pass break continue do then fi done esac default begin except catch elif loop yield await async".split(" "));
    tokens = (s) => s.split(/\W+/).filter(Boolean);
    REDACTED = "[line from implementation redacted]";
  }
});

// src/repair.ts
function redactRepairText(text, targets, opts = {}) {
  const lines = redactLeaks(text, targets, opts).split(/\r?\n/).filter((l) => !ASSERTISH.test(l) && !EQ_LITERAL.test(l)).map((l) => l.replace(/\bgot\b.*$/i, "got [value redacted]"));
  let out = lines.join("\n");
  if (Buffer.byteLength(out) > MAX_REPAIR_BYTES) out = Buffer.from(out).subarray(0, MAX_REPAIR_BYTES).toString("utf8").replace(/�$/, "") + "\n[truncated]";
  return out;
}
var ASSERTISH, EQ_LITERAL, MAX_REPAIR_BYTES;
var init_repair = __esm({
  "src/repair.ts"() {
    "use strict";
    init_leak();
    ASSERTISH = /\b(expected|actual|assert\w*)\b/i;
    EQ_LITERAL = /[!=]==?\s*(?:["'`\d-]|true\b|false\b|none\b|null\b|nil\b|undefined\b)/i;
    MAX_REPAIR_BYTES = 4096;
  }
});

// src/payload.ts
import * as fs9 from "node:fs";
import * as path8 from "node:path";
function assertBlindSafe(template, name) {
  const m = /\{\{\s*(?:#if\s+)?(target\.[\w.]*)\s*\}\}/.exec(template);
  if (m) throw rejected(`template ${name} references ${m[1]}; writer and repair templates must never see the target body`);
}
function renderTemplate(template, vars, opts) {
  if (BLIND_ROLES.includes(opts.role)) assertBlindSafe(template, opts.name);
  let t = template.replace(/<!--\s*variant:\s*([\w-]+)\s*-->\n?([\s\S]*?)<!--\s*\/variant\s*-->\n?/g, (_, v, body) => v === opts.variant ? body : "");
  t = t.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n/gm, "").replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(/\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, name, body) => {
    if (!(name.split(".")[0] in vars)) throw usage(`template ${opts.name}: unknown variable {{#if ${name}}}`);
    return present(lookup(vars, name)) ? body : "";
  });
  if (/\{\{\s*(#if|\/if)/.test(t)) throw usage(`template ${opts.name}: unbalanced {{#if}} block`);
  t = t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => {
    const v = lookup(vars, name);
    if (v === void 0 || v === null) throw usage(`template ${opts.name}: unknown variable {{${name}}}`);
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") throw usage(`template ${opts.name}: {{${name}}} is an object`);
    return String(v);
  });
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function renderPrompt(file, vars, role, variant) {
  const p = path8.join(pluginRoot(), "prompts", file);
  return renderTemplate(fs9.readFileSync(p, "utf8"), vars, { name: file, role, variant });
}
function newPayloadId() {
  return `p-${randHex(8)}`;
}
function frame(id, role, body) {
  const text = body.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const sha = sha256(text);
  return { full: `<<<TCHECK-PAYLOAD v1 id=${id} role=${role} sha256=${sha}>>>
${text}
<<<END TCHECK-PAYLOAD>>>`, sha };
}
function parseFrame(full) {
  const m = HEADER.exec(full.replace(/\r\n?/g, "\n").trim());
  return m ? { id: m[1], role: m[2], sha: m[3], body: m[4] } : null;
}
function indexPath(repo) {
  return repo.p("payloads", "index.json");
}
function withIndexLock(repo, fn) {
  const lock = repo.p("payloads", "index.lock");
  fs9.mkdirSync(path8.dirname(lock), { recursive: true });
  const deadline = Date.now() + 5e3;
  for (; ; ) {
    try {
      fs9.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch {
      if (Date.now() > deadline) fs9.rmSync(lock, { force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const idx = readJson(indexPath(repo), {});
    const out = fn(idx);
    writeJson(indexPath(repo), idx);
    return out;
  } finally {
    fs9.rmSync(lock, { force: true });
  }
}
function storePayload(repo, e, body) {
  const id = e.id ?? newPayloadId();
  const { full, sha } = frame(id, e.role, body);
  writeText(repo.p("payloads", `${id}.md`), full);
  const entry = { ...e, id, sha256: sha, consumed: false, created_at: nowIso() };
  withIndexLock(repo, (idx) => {
    idx[id] = entry;
  });
  repo.ledger("payload_emitted", { run: e.run, payload: id, role: e.role, sha256: sha, ...e.target ? { target: e.target } : {}, ...e.test ? { test: e.test } : {} });
  return { id, full, entry };
}
function loadPayload(repo, id) {
  if (!/^p-[0-9a-f]{8}$/.test(id)) throw usage(`not a payload id: ${id}`);
  const entry = readJson(indexPath(repo), {})[id];
  const file = repo.p("payloads", `${id}.md`);
  if (!entry || !fs9.existsSync(file)) throw rejected(`unknown payload ${id}`);
  const full = fs9.readFileSync(file, "utf8");
  const f = parseFrame(full);
  if (!f || f.id !== id || f.role !== entry.role || f.sha !== entry.sha256 || sha256(f.body) !== entry.sha256) {
    throw rejected(`payload ${id} failed its hash check (the frozen file was modified)`);
  }
  return { entry, full, body: f.body };
}
function consumePayload(repo, id) {
  withIndexLock(repo, (idx) => {
    if (!idx[id]) throw rejected(`unknown payload ${id}`);
    if (idx[id].consumed) throw rejected(`payload ${id} was already used; emit a new one`);
    idx[id].consumed = true;
    idx[id].consumed_at = nowIso();
  });
}
function payloadIndex(repo) {
  return readJson(indexPath(repo), {});
}
function requireRole(entry, roles) {
  if (!roles.includes(entry.role)) throw new TcheckError(`payload ${entry.id} has role ${entry.role}; expected ${roles.join(" or ")}`, EXIT.REJECTED);
}
var BLIND_ROLES, lookup, present, HEADER;
var init_payload = __esm({
  "src/payload.ts"() {
    "use strict";
    init_repo();
    init_util();
    BLIND_ROLES = ["writer", "repair"];
    lookup = (vars, name) => name.split(".").reduce((o, k) => o == null ? void 0 : o[k], vars);
    present = (v) => v !== void 0 && v !== null && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
    HEADER = /^<<<TCHECK-PAYLOAD v1 id=(p-[0-9a-f]{8}) role=(\w+) sha256=([0-9a-f]{64})>>>\n([\s\S]*)\n<<<END TCHECK-PAYLOAD>>>$/;
  }
});

// src/run.ts
import * as fs10 from "node:fs";
import * as os2 from "node:os";
import * as path9 from "node:path";
function runDir(repo, runId, ...p) {
  return repo.p("runs", runId, ...p);
}
function loadRun(repo, runId) {
  const f = runDir(repo, runId, "run.json");
  if (!fs10.existsSync(f)) throw usage(`unknown run: ${runId}`);
  return readJson(f);
}
function saveRun(repo, run2) {
  writeJson(runDir(repo, run2.id, "run.json"), run2);
}
function listRuns(repo) {
  const d = repo.p("runs");
  if (!fs10.existsSync(d)) return [];
  return fs10.readdirSync(d).filter((r) => fs10.existsSync(path9.join(d, r, "run.json"))).sort().map((r) => readJson(path9.join(d, r, "run.json")));
}
function newRunId() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `r-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randHex(4)}`;
}
function snapshotWorktree(repo, runId) {
  const head = repo.commit("HEAD");
  const idx = path9.join(os2.tmpdir(), `tcheck-index-${randHex(8)}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    repo.git(["read-tree", "HEAD"], { env });
    repo.git(["add", "-A", "--", ".", ":!.test-checker"], { env });
    const tree = repo.git(["write-tree"], { env }).trim();
    const ident = { GIT_AUTHOR_NAME: "tcheck", GIT_AUTHOR_EMAIL: "tcheck@localhost", GIT_COMMITTER_NAME: "tcheck", GIT_COMMITTER_EMAIL: "tcheck@localhost" };
    const commit = repo.git(["commit-tree", tree, "-p", head, "-m", "tcheck-snapshot"], { env: { ...process.env, ...ident } }).trim();
    repo.git(["update-ref", `refs/tcheck/${runId}/worktree`, commit]);
    return commit;
  } finally {
    fs10.rmSync(idx, { force: true });
  }
}
function runStart(repo, opts) {
  const mode = opts.mode;
  if (!LABELS[mode]) throw usage("--mode must be bugfix, new or audit");
  repo.config;
  if (!gitOk(repo.root, ["rev-parse", "--verify", "HEAD"])) throw new TcheckError("the repository has no commits yet", EXIT.ENV);
  const id = newRunId();
  const revisions = {};
  const given = {};
  const resolve3 = (label, rev) => {
    given[label] = rev;
    revisions[label] = rev === "WORKTREE" ? snapshotWorktree(repo, id) : repo.commit(rev);
  };
  if (mode === "bugfix") {
    resolve3("buggy", opts.buggy ?? "HEAD");
    resolve3("fixed", opts.fixed ?? "WORKTREE");
  } else {
    if (opts.buggy || opts.fixed) throw usage(`--buggy/--fixed only apply to bugfix mode`);
    resolve3("current", "WORKTREE");
  }
  const existing = (opts.existing ?? []).map((p) => repo.rel(p));
  if (mode === "audit" && !existing.length) throw usage("audit mode needs --existing <test paths>");
  for (const e of existing) if (!fs10.existsSync(path9.join(repo.root, e))) throw usage(`--existing path not found: ${e}`);
  const run2 = {
    id,
    mode,
    created_at: nowIso(),
    status: "open",
    revisions,
    given,
    spec_source: mode === "bugfix" ? repo.config.spec.source : "current",
    existing,
    targets: [],
    exec_count: 0
  };
  saveRun(repo, run2);
  repo.ledger("run_started", { run: id, mode, revisions, given });
  return run2;
}
function targetId(file, symbol) {
  return `${slug(file)}--${slug(symbol)}`;
}
function fileAt(repo, commit, file) {
  const r = repo.git(["show", `${commit}:${file}`], { allowFail: true });
  if (!r && !gitOk(repo.root, ["cat-file", "-e", `${commit}:${file}`])) throw usage(`${file} does not exist at ${commit.slice(0, 10)}`);
  return r;
}
function targetAdd(repo, runId, spec, linesArg, rev) {
  const run2 = loadRun(repo, runId);
  const m = /^(.+?)::(.+)$/.exec(spec);
  if (!m) throw usage("target must be <file>::<symbol>");
  const file = repo.rel(m[1]);
  const symbol = m[2];
  const lm = /^(\d+)-(\d+)$/.exec(linesArg ?? "");
  if (!lm) throw usage("--lines must be A-B");
  const a = parseInt(lm[1], 10);
  const b = parseInt(lm[2], 10);
  const label = rev ?? run2.spec_source;
  const commit = run2.revisions[label] ?? repo.commit(label);
  const text = fileAt(repo, commit, file);
  const all = text.split(/\r?\n/);
  if (text.endsWith("\n")) all.pop();
  if (a < 1 || b < a || b > all.length) throw usage(`--lines ${a}-${b} is empty or outside ${file} (${all.length} lines at ${label})`);
  const bodyArr = all.slice(a - 1, b);
  if (!bodyArr.some((l) => l.trim())) throw usage(`--lines ${a}-${b} of ${file} is blank`);
  const body = bodyArr.join("\n");
  const sigCount = signatureLineCount(bodyArr);
  const id = targetId(file, symbol);
  const t = {
    id,
    file,
    symbol,
    lines: [a, b],
    rev: label,
    commit,
    body,
    body_sha: sha256(body),
    body_lines: bodyArr.slice(sigCount).map(normalize),
    signature: bodyArr.slice(0, sigCount).join("\n")
  };
  writeJson(runDir(repo, runId, "targets", id, "target.json"), t);
  if (!run2.targets.includes(id)) run2.targets.push(id);
  saveRun(repo, run2);
  repo.ledger("target_added", { run: runId, target: id, file, symbol, lines: [a, b], rev: label, body_sha: t.body_sha });
  return t;
}
function loadTarget(repo, runId, targetIdArg) {
  const f = runDir(repo, runId, "targets", targetIdArg, "target.json");
  if (!fs10.existsSync(f)) throw usage(`unknown target ${targetIdArg} in run ${runId}`);
  return readJson(f);
}
function ensureWorktree(repo, sha, key = sha) {
  const dir = repo.p("worktrees", "_cache", key);
  const metaFile = repo.p("worktrees", "_cache", `${key}.json`);
  let fresh = false;
  if (!fs10.existsSync(path9.join(dir, ".git"))) {
    fs10.rmSync(dir, { recursive: true, force: true });
    repo.git(["worktree", "prune"], { allowFail: true });
    fs10.mkdirSync(path9.dirname(dir), { recursive: true });
    repo.git(["worktree", "add", "--detach", "--force", dir, sha]);
    fs10.rmSync(metaFile, { force: true });
    fresh = true;
  }
  const meta = readJson(metaFile, { setup_done: false, composed: [] });
  for (const f of meta.composed) fs10.rmSync(path9.join(dir, f), { force: true });
  meta.composed = [];
  repo.git(["-C", dir, "checkout", "--force", "--detach", sha], { allowFail: true });
  repo.git(["-C", dir, "checkout", "--", "."], { allowFail: true });
  return { dir, meta, fresh, saveMeta: () => writeJson(metaFile, meta) };
}
function words(symbol) {
  return symbol.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
}
function packagePath(file) {
  const dir = path9.posix.dirname(file);
  const m = /(?:^|\/)(?:java|kotlin|scala|groovy)\/(.*)$/.exec(dir);
  return m ? m[1] : dir === "." ? "" : dir;
}
function expandPath(template, t, n) {
  const w = words(t.symbol);
  const vals = {
    symbol: w.map((x) => x.toLowerCase()).join("_"),
    Symbol: w.map((x) => x[0].toUpperCase() + x.slice(1)).join(""),
    target_slug: t.id.replace(/-/g, "_"),
    pkg_dir: path9.posix.dirname(t.file),
    package_path: packagePath(t.file)
  };
  if (n !== void 0) vals.n = String(n);
  return template.replace(/\{(\w+)\}/g, (m, k) => vals[k] ?? m).replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}
function nameShape(pattern, t) {
  const expanded = expandPath(pattern, t);
  const first = expanded.indexOf("{");
  const last = expanded.lastIndexOf("}");
  return {
    prefix: first < 0 ? expanded : expanded.slice(0, first),
    suffix: last < 0 ? "" : expanded.slice(last + 1),
    example: expandPath(pattern, t, 1)
  };
}
function checkFileName(name, pattern, t) {
  if (!name || /[\\/]/.test(name) || name.includes("..") || name.startsWith(".")) return `"${name}": use a plain file name (no directories)`;
  const s = nameShape(pattern, t);
  if (!name.startsWith(s.prefix) || !name.endsWith(s.suffix) || name.length < s.prefix.length + s.suffix.length) {
    return `"${name}" does not match the naming pattern (e.g. ${s.example})`;
  }
  return null;
}
function generatedDir(repo, runId, targetIdArg, round) {
  const base = repo.p("generated", runId, targetIdArg);
  return round === void 0 ? base : path9.join(base, `round-${round}`);
}
function latestRound(repo, runId, targetIdArg) {
  const base = generatedDir(repo, runId, targetIdArg);
  if (!fs10.existsSync(base)) return null;
  const rounds = fs10.readdirSync(base).map((d) => /^round-(\d+)$/.exec(d)).filter(Boolean).map((m) => parseInt(m[1], 10));
  return rounds.length ? Math.max(...rounds) : null;
}
function compose(repo, runId) {
  const run2 = loadRun(repo, runId);
  const cfg = repo.config;
  const files = [];
  const missing = [];
  const outDir = runDir(repo, runId, "composed");
  fs10.rmSync(outDir, { recursive: true, force: true });
  for (const tid of run2.targets) {
    const t = loadTarget(repo, runId, tid);
    const round = latestRound(repo, runId, tid);
    if (round === null) {
      missing.push(tid);
      continue;
    }
    const dir = expandPath(cfg.test_dir, t);
    for (const src of listFilesRecursive(generatedDir(repo, runId, tid, round))) {
      const name = path9.basename(src);
      if (isRoundMeta(name)) continue;
      const final = path9.posix.join(dir, name);
      const clash = files.find((f) => f.path === final);
      if (clash) throw rejected(`two targets produced the same test file ${final} (${clash.target}, ${tid}); use {target_slug} in test_file_pattern`);
      files.push({ path: final, target: tid, round, source: path9.relative(repo.root, src) });
      writeText(path9.join(outDir, final), fs10.readFileSync(src, "utf8"));
    }
  }
  if (!files.length) throw usage(`no submitted tests to compose in ${runId}${missing.length ? ` (waiting on: ${missing.join(", ")})` : ""}`);
  writeJson(runDir(repo, runId, "composed.json"), { at: nowIso(), files });
  return { files, missing };
}
var LABELS, ERRORS_LABEL, isRoundMeta;
var init_run = __esm({
  "src/run.ts"() {
    "use strict";
    init_util();
    init_leak();
    LABELS = { bugfix: ["buggy", "fixed"], new: ["current"], audit: ["current"] };
    ERRORS_LABEL = { bugfix: "fixed", new: "current", audit: "current" };
    isRoundMeta = (name) => name === "notes.md" || name === "round.json";
  }
});

// src/spec.ts
import * as fs11 from "node:fs";
import * as path10 from "node:path";
function leakContext(repo, runId) {
  const run2 = loadRun(repo, runId);
  return {
    targets: run2.targets.map((t) => loadTarget(repo, runId, t)),
    opts: { common: commonLines(repo, runId), minLen: repo.config.leak.min_line_length, threshold: repo.config.leak.shingle_threshold }
  };
}
function assertNoLeak(repo, runId, text, where, advice) {
  const { targets, opts } = leakContext(repo, runId);
  const r = checkLeak(text, targets, opts);
  if (!r.passed) throw rejected(`leak check failed for ${where}:
${formatFindings(r, where)}
${advice}`, r);
  return { shingle_ratio: r.shingle_ratio };
}
function bundleSchema() {
  bundleSchemaCache ??= readJson(path10.join(pluginRoot(), "skills", "verify-tests", "references", "bundle.schema.json"));
  return bundleSchemaCache;
}
function jsonStrings(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(jsonStrings).join("\n");
  if (v && typeof v === "object") return Object.values(v).map(jsonStrings).join("\n");
  return "";
}
function contextSet(repo, runId, targetId2, file) {
  loadTarget(repo, runId, targetId2);
  let ctx;
  try {
    ctx = JSON.parse(fs11.readFileSync(file, "utf8"));
  } catch (e) {
    throw rejected(`${file} is not valid JSON: ${e.message}`);
  }
  const errs = validate(bundleSchema().properties.context, ctx, "context");
  if (errs.length) throw rejected(`context does not match bundle.schema.json:
  ${errs.join("\n  ")}`, errs);
  const leak = assertNoLeak(repo, runId, jsonStrings(ctx), "context", "Context must hold signatures only, never lines from the target body.");
  writeJson(runDir(repo, runId, "targets", targetId2, "context.json"), ctx);
  repo.ledger("context_set", { run: runId, target: targetId2, shingle_ratio: leak.shingle_ratio });
  return { target: targetId2, leak_check: "passed" };
}
function loadContext(repo, runId, targetId2) {
  return readJson(runDir(repo, runId, "targets", targetId2, "context.json"), {});
}
function contextMarkdown(ctx, tag3, opts = {}) {
  const out = [];
  const et = ctx.enclosing_type;
  if (et) {
    out.push(`### Enclosing type \`${et.name ?? "?"}\``);
    if (et.constructors?.length) out.push("Constructors:", fence(tag3, et.constructors));
    if (et.fields?.length) out.push("Fields:", fence(tag3, et.fields));
    if (et.sibling_signatures?.length) out.push("Other methods:", fence(tag3, et.sibling_signatures));
  }
  for (const t of ctx.types ?? []) {
    out.push(`### Type \`${t.name}\`${t.file ? ` (${t.file})` : ""}`);
    if (t.constructors?.length) out.push("Constructors:", fence(tag3, t.constructors));
    if (t.public_signatures?.length) out.push("Public members:", fence(tag3, t.public_signatures));
  }
  if (ctx.module_signatures?.length) out.push("### Other functions in the module", fence(tag3, ctx.module_signatures));
  const tc = ctx.test_conventions ?? {};
  if (!opts.forWriter && tc.imports?.length) out.push("### Test imports", fence(tag3, tc.imports));
  if (tc.fixtures?.length) out.push("### Available fixtures and helpers", tc.fixtures.map((f) => `- ${f}`).join("\n"));
  return out.length ? out.join("\n\n") : "(none provided)";
}
function variantFor(repo) {
  const v = repo.config.spec.variant;
  return v === "auto" ? "reasoning" : v;
}
function configVars(repo, t) {
  const c = repo.config;
  return { language: c.language, language_tag: c.language_tag, framework: c.framework, test_file_pattern: expandPath(c.test_file_pattern, t) };
}
function specPrompt(repo, runId, targetId2, intent) {
  const t = loadTarget(repo, runId, targetId2);
  const vars = {
    ...configVars(repo, t),
    target: { symbol: t.symbol, file: t.file, body: t.body },
    context_markdown: contextMarkdown(loadContext(repo, runId, targetId2), repo.config.language_tag),
    intent_hint: intent ?? ""
  };
  const body = renderPrompt(`spec-extract.${repo.config.spec.prompt}.md`, vars, "spec", variantFor(repo));
  return storePayload(repo, { role: "spec", run: runId, target: targetId2 }, body);
}
function parseSpecOutput(raw) {
  let spec = tag(raw, "spec");
  const analysis = tag(raw, "analysis") ?? "";
  if (!spec) {
    const m = /Part\s*3[^\n]*\n([\s\S]+)$/i.exec(raw);
    spec = m ? m[1].trim() : null;
  }
  if (!spec) throw rejected("no <spec> block found in the spec-extractor output. Ask the role to answer in the required format and save again.");
  return { spec, analysis };
}
function specSave(repo, runId, targetId2, raw) {
  loadTarget(repo, runId, targetId2);
  const { spec, analysis } = parseSpecOutput(raw);
  const leak = assertNoLeak(repo, runId, spec, "spec", "The spec quotes the implementation. Re-run the spec extractor, or fix it with `tcheck spec edit`.");
  const dir = runDir(repo, runId, "targets", targetId2);
  writeText(path10.join(dir, "spec.raw.md"), raw);
  writeText(path10.join(dir, "spec.md"), spec + "\n");
  writeText(path10.join(dir, "analysis.md"), analysis ? analysis + "\n" : "");
  repo.ledger("spec_saved", { run: runId, target: targetId2, shingle_ratio: leak.shingle_ratio });
  return { target: targetId2, spec, analysis, leak_check: "passed" };
}
function specShow(repo, runId, targetId2) {
  const dir = runDir(repo, runId, "targets", targetId2);
  if (!fs11.existsSync(path10.join(dir, "spec.md"))) throw usage(`no spec saved for ${targetId2}; run \`tcheck spec prompt ${runId} ${targetId2}\` first`);
  return { target: targetId2, spec: fs11.readFileSync(path10.join(dir, "spec.md"), "utf8").trim(), analysis: fs11.existsSync(path10.join(dir, "analysis.md")) ? fs11.readFileSync(path10.join(dir, "analysis.md"), "utf8").trim() : "" };
}
function specEdit(repo, runId, targetId2, text) {
  loadTarget(repo, runId, targetId2);
  const spec = (tag(text, "spec") ?? text).trim();
  if (!spec) throw rejected("the new spec is empty");
  assertNoLeak(repo, runId, spec, "spec", "The edited spec quotes the implementation.");
  writeText(runDir(repo, runId, "targets", targetId2, "spec.md"), spec + "\n");
  repo.ledger("spec_edited", { run: runId, target: targetId2 });
  return { target: targetId2, spec, note: "Existing bundles for this target are now stale; run `tcheck bundle build` again." };
}
function loadSpec(repo, runId, targetId2) {
  const f = runDir(repo, runId, "targets", targetId2, "spec.md");
  return fs11.existsSync(f) ? fs11.readFileSync(f, "utf8").trim() : null;
}
var bundleSchemaCache, fence, tag;
var init_spec = __esm({
  "src/spec.ts"() {
    "use strict";
    init_repo();
    init_leak();
    init_run();
    init_payload();
    init_schema();
    init_util();
    fence = (tag3, lines) => "```" + tag3 + "\n" + lines.join("\n") + "\n```";
    tag = (text, name) => {
      const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(text);
      return m ? m[1].trim() : null;
    };
  }
});

// src/bundle.ts
import * as fs12 from "node:fs";
import * as path11 from "node:path";
function bundleId(runId, targetId2) {
  return `b-${runId.slice(-4)}-${targetId2}`;
}
function loadBundle(repo, id) {
  const f = repo.p("bundles", `${id}.json`);
  if (!fs12.existsSync(f)) throw usage(`unknown bundle: ${id}`);
  return readJson(f);
}
function bundleBuild(repo, runId, targetId2) {
  const t = loadTarget(repo, runId, targetId2);
  const spec = loadSpec(repo, runId, targetId2);
  if (!spec) throw usage(`no spec for ${targetId2}; save one with \`tcheck spec save\` first`);
  const context = loadContext(repo, runId, targetId2);
  const id = bundleId(runId, targetId2);
  const focal = { name: t.symbol, signature: t.signature.trim(), file: t.file, language: repo.config.language };
  const leak = assertNoLeak(repo, runId, jsonStrings({ spec, context }), "bundle", "Fix the spec or context, then build again.");
  const bundle = {
    focal,
    spec,
    context,
    meta: { bundle_id: id, run_id: runId, target_id: targetId2, created_at: nowIso(), leak_check: { passed: true, method: "line+shingle (engine-spec \xA76)", max_shared_line_ratio: leak.shingle_ratio } }
  };
  const errs = validate(bundleSchema(), bundle, "bundle");
  if (errs.length) throw rejected(`bundle does not match bundle.schema.json:
  ${errs.join("\n  ")}`, errs);
  writeJson(repo.p("bundles", `${id}.json`), bundle);
  repo.ledger("bundle_frozen", { run: runId, target: targetId2, bundle: id });
  return { bundle: id };
}
function previousTestsMarkdown(repo, runId, targetId2, tag3) {
  const round = latestRound(repo, runId, targetId2);
  if (round === null) return "(none)";
  return listFilesRecursive(generatedDir(repo, runId, targetId2, round)).filter((f) => !isRoundMeta(path11.basename(f))).map((f) => `FILE: ${path11.basename(f)}
\`\`\`${tag3}
${fs12.readFileSync(f, "utf8").trimEnd()}
\`\`\``).join("\n\n");
}
function repairRoundsSoFar(repo, runId, targetId2) {
  let n = 0;
  for (let r = latestRound(repo, runId, targetId2); r !== null && r >= 0; r--) {
    const meta = readJson(path11.join(generatedDir(repo, runId, targetId2, r), "round.json"), {});
    if (meta.role !== "repair") break;
    n++;
  }
  return n;
}
function filteredErrors(repo, runId, targetId2) {
  const rep = readJson(runDir(repo, runId, "repairable.json"), { targets: {} });
  const items = rep.targets[targetId2] ?? [];
  if (!items.length) return "";
  const { targets, opts } = leakContext(repo, runId);
  const groups = /* @__PURE__ */ new Map();
  for (const i of items) {
    const key = i.kind === "compile" ? "(compile step)" : i.file ? path11.basename(i.file) : "(run)";
    const text = i.kind === "error" && i.test ? `${i.test}: ${i.text}` : i.text;
    groups.set(key, [...groups.get(key) ?? [], text]);
  }
  return [...groups.entries()].map(([file, texts]) => `== ${file} ==
${redactRepairText([...new Set(texts)].join("\n"), targets, opts)}`).join("\n\n");
}
function bundleEmit(repo, id, role, opts = {}) {
  if (role !== "writer" && role !== "repair") throw usage("--role must be writer or repair");
  const bundle = loadBundle(repo, id);
  const runId = opts.run ?? bundle.meta.run_id;
  if (runId !== bundle.meta.run_id) throw usage(`bundle ${id} belongs to run ${bundle.meta.run_id}, not ${runId}`);
  const targetId2 = bundle.meta.target_id;
  const t = loadTarget(repo, runId, targetId2);
  if (loadSpec(repo, runId, targetId2) !== bundle.spec) throw rejected(`bundle ${id} is stale: the spec was edited since it was built. Run \`tcheck bundle build ${runId} ${targetId2}\`.`);
  const cfg = repo.config;
  const payloadId = newPayloadId();
  const via = opts.via ?? "tool";
  const vars = {
    ...configVars(repo, t),
    bundle,
    bundle_context_markdown: contextMarkdown(bundle.context, cfg.language_tag, { forWriter: true }),
    payload_id: payloadId,
    submit_via_tool: via === "tool" ? "yes" : "",
    submit_via_text: via === "text" ? "yes" : ""
  };
  let round = (latestRound(repo, runId, targetId2) ?? -1) + 1;
  if (role === "repair") {
    if (latestRound(repo, runId, targetId2) === null) throw usage(`no tests submitted for ${targetId2} yet; emit a writer payload first`);
    const done = repairRoundsSoFar(repo, runId, targetId2);
    if (done >= cfg.refine_rounds) throw rejected(`${targetId2} already had ${done} repair round(s) (refine_rounds: ${cfg.refine_rounds}). Remaining broken tests are dropped.`);
    const errors = filteredErrors(repo, runId, targetId2);
    if (!errors) throw rejected(`the latest exec has no repairable errors for ${targetId2}; nothing to repair`);
    Object.assign(vars, { previous_tests_markdown: previousTestsMarkdown(repo, runId, targetId2, cfg.language_tag), filtered_errors: errors, round: done + 1, max_rounds: cfg.refine_rounds });
  }
  const body = renderPrompt(role === "writer" ? "blind-write.md" : "repair.md", vars, role);
  assertNoLeak(repo, runId, body, `${role} payload`, "Refusing to emit a blind payload that contains the implementation.");
  if (role === "repair") round = latestRound(repo, runId, targetId2) + 1;
  const { full } = storePayload(repo, { id: payloadId, role, run: runId, target: targetId2, bundle: id, round }, body);
  return { payload: payloadId, full, target: targetId2, round };
}
function submitTests(repo, payloadId, files, notes) {
  const { entry } = loadPayload(repo, payloadId);
  requireRole(entry, ["writer", "repair", "baseline"]);
  if (entry.consumed) throw rejected(`payload ${payloadId} was already used; emit a new one`);
  const targetId2 = entry.target;
  const t = loadTarget(repo, entry.run, targetId2);
  if (!Array.isArray(files) || !files.length) throw rejected("no files submitted");
  if (files.length > MAX_FILES) throw rejected(`too many files (${files.length} > ${MAX_FILES})`);
  const total = files.reduce((n, f) => n + Buffer.byteLength(String(f.content ?? "")), 0);
  if (total > MAX_BYTES) throw rejected(`files total ${total} bytes (> ${MAX_BYTES})`);
  const problems = files.flatMap((f) => {
    const p = checkFileName(String(f.path ?? ""), repo.config.test_file_pattern, t);
    return p ? [p] : typeof f.content !== "string" || !f.content.trim() ? [`"${f.path}" is empty`] : [];
  });
  if (new Set(files.map((f) => f.path)).size !== files.length) problems.push("duplicate file names");
  if (problems.length) throw rejected(`submission rejected:
  ${problems.join("\n  ")}`);
  consumePayload(repo, payloadId);
  const prev = latestRound(repo, entry.run, targetId2);
  const round = prev === null ? 0 : prev + 1;
  const dir = generatedDir(repo, entry.run, targetId2, round);
  fs12.mkdirSync(dir, { recursive: true });
  if (entry.role === "repair" && prev !== null) {
    for (const f of listFilesRecursive(generatedDir(repo, entry.run, targetId2, prev))) {
      const name = path11.basename(f);
      if (!isRoundMeta(name) && !files.some((s) => s.path === name)) fs12.copyFileSync(f, path11.join(dir, name));
    }
  }
  for (const f of files) writeText(path11.join(dir, f.path), f.content.endsWith("\n") ? f.content : f.content + "\n");
  if (notes?.trim()) writeText(path11.join(dir, "notes.md"), notes.trim() + "\n");
  writeJson(path11.join(dir, "round.json"), { role: entry.role, payload: payloadId, at: nowIso() });
  repo.ledger("tests_submitted", { run: entry.run, target: targetId2, round, role: entry.role, payload: payloadId, files: files.map((f) => f.path) });
  return { message: `Stored ${files.length} test file${files.length === 1 ? "" : "s"} for ${targetId2} (round ${round}).`, target: targetId2, round, files: files.map((f) => f.path) };
}
function parseTextSubmission(text) {
  const files = [];
  const re = /^[ \t>*_#-]*FILE:\s*[`*"]*([^\s`*"]+)[`*"]*\s*\n+(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2[ \t]*$/gm;
  let last = 0;
  for (let m; m = re.exec(text); ) {
    files.push({ path: m[1].trim(), content: m[3] + "\n" });
    last = re.lastIndex;
  }
  const nm = /^[ \t*_#]*NOTES:?[*_]*[ \t]*\n?([\s\S]*)$/m.exec(text.slice(last));
  return { files, notes: nm ? nm[1].trim() : "" };
}
function ingest(repo, payloadId, text) {
  const { files, notes } = parseTextSubmission(text);
  if (!files.length) throw rejected("no `FILE: <name>` + fenced code blocks found in the output");
  return submitTests(repo, payloadId, files, notes);
}
var MAX_FILES, MAX_BYTES;
var init_bundle = __esm({
  "src/bundle.ts"() {
    "use strict";
    init_run();
    init_spec();
    init_payload();
    init_repair();
    init_schema();
    init_util();
    MAX_FILES = 20;
    MAX_BYTES = 200 * 1024;
  }
});

// src/exec.ts
import * as fs13 from "node:fs";
import * as path12 from "node:path";
function repairPatterns(cfg) {
  const src = cfg.repair_error_patterns ?? DEFAULT_PATTERNS[FAMILY[cfg.language.toLowerCase()]] ?? Object.values(DEFAULT_PATTERNS).flat();
  return src.map((p) => new RegExp(p));
}
function commandEnv(cfg) {
  const keep = /* @__PURE__ */ new Set([
    "PATH",
    "HOME",
    "LANG",
    "PYTHONPATH",
    "NODE_PATH",
    "GOPATH",
    "JAVA_HOME",
    "CARGO_HOME",
    // OS plumbing without which shells and toolchains misbehave
    "TMPDIR",
    "TEMP",
    "TMP",
    "USER",
    "LOGNAME",
    "SHELL",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "SystemRoot",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    ...cfg.env_passthrough
  ]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.has(k)) env[k] = v;
  return env;
}
function fillCommand(cmd, vars) {
  return cmd.replace(/\{(files|junit|test_dir|root|per_test_seconds)\}/g, (m, k) => vars[k] ?? m);
}
function mapCase(c, files) {
  const noExt = (p) => p.replace(/\.[^/.]+$/, "");
  const stem = (p) => path12.posix.basename(p).split(".")[0];
  const tryName = (cn) => {
    if (!cn) return void 0;
    const asPath = cn.replace(/\\/g, "/");
    let hit = files.find((f2) => asPath === f2.path || asPath.endsWith("/" + f2.path) || f2.path.endsWith("/" + asPath) || noExt(asPath) === noExt(f2.path));
    if (hit) return hit;
    hit = files.find((f2) => {
      const dotted = noExt(f2.path).replace(/\//g, ".");
      return cn === dotted || cn.startsWith(dotted + ".") || dotted.endsWith("." + cn);
    });
    if (hit) return hit;
    const segs = cn.split(/[./\\:]+/);
    const byStem = files.filter((f2) => segs.includes(stem(f2.path)));
    return byStem.length === 1 ? byStem[0] : void 0;
  };
  if (c.file) {
    const f2 = tryName(c.file);
    if (f2) return f2;
  }
  const f = tryName(c.classname) ?? (c.classname ? void 0 : tryName(c.name));
  if (f) return f;
  const bare = c.name.replace(/\[.*$/, "").replace(/\(.*$/, "").split(/[./ ]/).pop() ?? "";
  if (bare.length >= 3) {
    const re = new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const byContent = files.filter((x) => re.test(x.content));
    if (byContent.length === 1) return byContent[0];
  }
  return files.length === 1 ? files[0] : void 0;
}
function isRepairable(c, patterns) {
  if ((c.outcome ?? c.final) !== "error") return false;
  const hay = [c.type, c.message, c.text?.split("\n").slice(-5).join("\n")].filter(Boolean).join("\n");
  return patterns.some((p) => p.test(hay));
}
async function execRun(repo, runId, opts = {}) {
  const run2 = loadRun(repo, runId);
  const cfg = repo.config;
  const log = opts.log ?? ((s) => process.stderr.write(s + "\n"));
  const composedFile = runDir(repo, runId, "composed.json");
  if (!fs13.existsSync(composedFile)) throw usage(`nothing composed for ${runId}; run \`tcheck compose ${runId}\` first`);
  const composed = readJson(composedFile).files;
  const n = run2.exec_count + 1;
  const env = commandEnv(cfg);
  const patterns = repairPatterns(cfg);
  const results = { exec: n, at: nowIso(), labels: {} };
  const files = [
    ...composed.map((f) => ({ path: f.path, target: f.target, content: fs13.readFileSync(path12.join(runDir(repo, runId, "composed"), f.path), "utf8") })),
    ...run2.existing.map((p) => ({ path: p, target: "existing", content: fs13.readFileSync(path12.join(repo.root, p), "utf8") }))
  ];
  const testDir = composed.length ? path12.posix.dirname(composed[0].path) : "";
  const runLabel = async (label, commit, reruns, patch, only) => {
    const wt = ensureWorktree(repo, commit, patch ? `${commit}-mutant` : commit);
    const lr = { commit, load_errors: [], timed_out: [], tests: {}, unmapped: 0 };
    const labelFiles = only ?? files;
    for (const f of composed) {
      const src = path12.join(runDir(repo, runId, "composed"), f.path);
      const dst = path12.join(wt.dir, f.path);
      fs13.mkdirSync(path12.dirname(dst), { recursive: true });
      fs13.copyFileSync(src, dst);
      wt.meta.composed.push(f.path);
    }
    wt.saveMeta();
    if (patch) {
      const r = await shell("git apply --whitespace=nowarn -", { cwd: wt.dir, env: process.env, input: patch });
      if (r.code !== 0) {
        lr.setup_error = `mutant patch did not apply: ${tail(r.stderr, 500)}`;
        return lr;
      }
    }
    const vars = { files: labelFiles.map((f) => q(f.path)).join(" "), test_dir: testDir, root: wt.dir, junit: "", per_test_seconds: String(cfg.timeouts.per_test_seconds) };
    const timeout = cfg.timeouts.per_command_seconds;
    if (cfg.commands.setup && !wt.meta.setup_done) {
      log(`[${label}] setup: ${cfg.commands.setup}`);
      const r = await shell(fillCommand(cfg.commands.setup, vars), { cwd: wt.dir, env, timeoutSec: timeout });
      if (r.code !== 0) {
        lr.setup_error = tail(r.stdout + r.stderr);
        return lr;
      }
      wt.meta.setup_done = true;
      wt.saveMeta();
    }
    if (cfg.commands.compile) {
      log(`[${label}] compile: ${cfg.commands.compile}`);
      const r = await shell(fillCommand(cfg.commands.compile, vars), { cwd: wt.dir, env, timeoutSec: timeout });
      if (r.code !== 0) {
        lr.compile_error = tail(r.stdout + "\n" + r.stderr);
        return lr;
      }
    }
    const perRerun = [];
    for (let k = 1; k <= reruns; k++) {
      const kdir = runDir(repo, runId, "exec", String(n), label, String(k));
      fs13.rmSync(kdir, { recursive: true, force: true });
      fs13.mkdirSync(kdir, { recursive: true });
      const junit = path12.join(kdir, "junit.xml");
      const cmd = fillCommand(cfg.commands.run, { ...vars, junit: q(junit) });
      log(`[${label}] run ${k}/${reruns}`);
      const r = await shell(cmd, { cwd: wt.dir, env, timeoutSec: timeout });
      fs13.writeFileSync(path12.join(kdir, "output.txt"), `$ ${cmd}
exit ${r.code}${r.timedOut ? " (timeout)" : ""}

${r.stdout}
${r.stderr}`);
      if (r.timedOut) lr.timed_out.push(k);
      const seen = /* @__PURE__ */ new Map();
      for (const c of readJUnitPath(kdir)) {
        const f = mapCase(c, labelFiles);
        if (!f) {
          lr.unmapped++;
          continue;
        }
        seen.set(`${f.target}::${c.classname}::${c.name}`, { c, f });
      }
      const explained = [...seen.values()].some((s) => isRepairable(s.c, patterns));
      if (r.code !== 0 && !r.timedOut && !explained) {
        for (const f of labelFiles) {
          if (f.target === "existing") continue;
          if (![...seen.values()].some((s) => s.f === f) && !lr.load_errors.some((e) => e.file === f.path)) {
            lr.load_errors.push({ file: f.path, target: f.target, text: tail(r.stdout + "\n" + r.stderr) });
          }
        }
      }
      perRerun.push(seen);
      if (r.timedOut) break;
    }
    const ids = new Set(perRerun.flatMap((m) => [...m.keys()]));
    for (const id of ids) {
      const outcomes = perRerun.map((m, i) => m.get(id)?.c.outcome ?? (lr.timed_out.includes(i + 1) ? "error" : null));
      const present2 = outcomes.filter((o) => o !== null);
      const first = perRerun.map((m) => m.get(id)).find(Boolean);
      const final = new Set(present2).size > 1 ? "flaky" : present2[0];
      const c = first.c;
      lr.tests[id] = { id, target: first.f.target, file: first.f.path, classname: c.classname, name: c.name, outcomes, final, type: c.type, message: c.message, text: c.text ? tail(c.text) : void 0 };
      if (isRepairable({ final, type: c.type, message: c.message, text: c.text }, patterns)) lr.tests[id].repairable = true;
    }
    return lr;
  };
  if (run2.exec_count > 0) {
    for (const [label, given] of Object.entries(run2.given)) {
      if (given !== "WORKTREE") continue;
      const sha = snapshotWorktree(repo, runId);
      if (sha !== run2.revisions[label]) {
        repo.ledger("revision_refreshed", { run: runId, label, from: run2.revisions[label], to: sha });
        run2.revisions[label] = sha;
      }
    }
  }
  for (const label of LABELS[run2.mode]) {
    results.labels[label] = await runLabel(label, run2.revisions[label], cfg.flake_reruns);
  }
  if (run2.mode === "new" && cfg.commands.mutate) {
    results.mutants = await runMutants(repo, run2, results, runLabel, log);
  }
  run2.exec_count = n;
  saveRun(repo, run2);
  writeJson(runDir(repo, runId, "exec", String(n), "results.json"), results);
  writeJson(runDir(repo, runId, "results.json"), results);
  const repair = repairableByTarget(run2, results, patterns);
  writeJson(runDir(repo, runId, "repairable.json"), { exec: n, targets: repair });
  const status2 = {};
  const setupFailed = Object.values(results.labels).some((l) => l.setup_error);
  for (const t of run2.targets) {
    if (setupFailed) status2[t] = { status: "failed_setup" };
    else if (repair[t]?.length) status2[t] = { status: "needs_repair", count: repair[t].length };
    else status2[t] = { status: "ok" };
  }
  const summary = Object.fromEntries(
    Object.entries(results.labels).map(([l, r]) => {
      const counts2 = {};
      for (const t of Object.values(r.tests)) counts2[t.final] = (counts2[t.final] ?? 0) + 1;
      return [l, { ...counts2, load_errors: r.load_errors.length, ...r.compile_error ? { compile_error: true } : {}, ...r.setup_error ? { setup_error: true } : {} }];
    })
  );
  repo.ledger("exec_completed", { run: runId, exec: n, labels: summary });
  return { exec: n, targets: status2, labels: summary, setup_error: Object.entries(results.labels).find(([, l]) => l.setup_error)?.[1].setup_error, code: setupFailed ? EXIT.COMMAND : EXIT.OK };
}
function repairableByTarget(run2, results, patterns) {
  const lr = results.labels[ERRORS_LABEL[run2.mode]];
  const out = {};
  if (!lr) return out;
  const add = (t, r) => (out[t] ??= []).push(r);
  for (const t of run2.targets) {
    if (lr.compile_error) add(t, { kind: "compile", text: lr.compile_error });
  }
  for (const e of lr.load_errors) add(e.target, { kind: "load", file: e.file, text: e.text });
  for (const t of Object.values(lr.tests)) {
    if (t.target !== "existing" && t.repairable) add(t.target, { kind: "error", file: t.file, test: t.name, text: [t.type, t.message, t.text].filter(Boolean).join(": ") });
  }
  void patterns;
  return out;
}
async function runMutants(repo, run2, results, runLabel, log) {
  const cfg = repo.config;
  const current = results.labels.current;
  const accepted = Object.values(current.tests).filter((t) => t.final === "pass" && t.target !== "existing");
  const out = {};
  if (!accepted.length) return out;
  const targetFiles = run2.targets.map((t) => readJson(runDir(repo, run2.id, "targets", t, "target.json")).file);
  const wt = ensureWorktree(repo, run2.revisions.current);
  const r = await shell(fillCommand(cfg.commands.mutate, { files: targetFiles.map(q).join(" "), root: wt.dir, test_dir: "", junit: "" }), {
    cwd: wt.dir,
    env: commandEnv(cfg),
    timeoutSec: cfg.timeouts.per_command_seconds
  });
  if (r.code !== 0) {
    log(`mutate command failed: ${tail(r.stderr, 300)}`);
    return out;
  }
  const perFile = /* @__PURE__ */ new Map();
  const mutants = r.stdout.split("\n").map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((m) => m && m.id && m.patch).filter((m) => {
    const c = (perFile.get(m.file) ?? 0) + 1;
    perFile.set(m.file, c);
    return c <= cfg.mutation.max_mutants_per_target;
  });
  for (const m of mutants) {
    const label = `mutant-${m.id}`;
    const lr = await runLabel(label, run2.revisions.current, 1, m.patch);
    results.labels[label] = lr;
    const killed = accepted.filter((t) => lr.tests[t.id] && lr.tests[t.id].final !== "pass").map((t) => t.id);
    out[m.id] = { file: m.file, killed_by: killed };
  }
  return out;
}
function loadResults(repo, runId) {
  const f = runDir(repo, runId, "results.json");
  if (!fs13.existsSync(f)) throw usage(`no results for ${runId}; run \`tcheck exec ${runId}\``);
  return readJson(f);
}
var DEFAULT_PATTERNS, FAMILY, q, tail;
var init_exec = __esm({
  "src/exec.ts"() {
    "use strict";
    init_junit();
    init_run();
    init_util();
    DEFAULT_PATTERNS = {
      python: ["ImportError", "ModuleNotFoundError", "SyntaxError", "NameError", "fixture '.*' not found", "TypeError: .*__init__\\(\\)"],
      js: ["Cannot find module", "SyntaxError", "ReferenceError", "is not a constructor", "TS\\d{4}"],
      jvm: ["cannot find symbol", "NoClassDefFoundError", "ClassNotFoundException"],
      go: ["undefined:", "cannot use", "imported and not used"],
      rust: ["error\\[E\\d{4}\\]"]
    };
    FAMILY = {
      python: "python",
      typescript: "js",
      javascript: "js",
      ts: "js",
      js: "js",
      java: "jvm",
      kotlin: "jvm",
      scala: "jvm",
      groovy: "jvm",
      go: "go",
      golang: "go",
      rust: "rust"
    };
    q = (p) => /[\s"'$`\\]/.test(p) ? isWin ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'` : p;
    tail = (s, n = 4e3) => s.length > n ? "\u2026" + s.slice(-n) : s;
  }
});

// src/classify.ts
import * as fs14 from "node:fs";
function outcomeOf(lr, id) {
  if (!lr) return "missing";
  const t = lr.tests[id];
  if (t) return t.final;
  return lr.timed_out.length ? "timeout" : lr.compile_error ? "compile-error" : "missing";
}
function classify(repo, runId) {
  const run2 = loadRun(repo, runId);
  const res = loadResults(repo, runId);
  const errLabel = ERRORS_LABEL[run2.mode];
  const tests = [];
  const queue2 = [];
  const dropped = [];
  const all = /* @__PURE__ */ new Map();
  for (const [label, lr] of Object.entries(res.labels)) {
    if (label.startsWith("mutant-")) continue;
    for (const t of Object.values(lr.tests)) if (!all.has(t.id)) all.set(t.id, t);
  }
  const errLr = res.labels[errLabel];
  for (const e of errLr?.load_errors ?? []) dropped.push({ file: e.file, target: e.target, reason: "load error (no test cases produced)" });
  for (const t of all.values()) {
    const outcomes = {};
    for (const label of Object.keys(res.labels)) if (!label.startsWith("mutant-")) outcomes[label] = outcomeOf(res.labels[label], t.id);
    const c = { id: t.id, target: t.target, file: t.file, name: t.name, category: "neutral", outcomes };
    const vals = Object.values(outcomes);
    if (t.target === "existing") {
      c.existing = true;
      c.category = vals.includes("flaky") ? "flaky" : passed(outcomes.current) ? "accepted" : "disputed";
      tests.push(c);
      continue;
    }
    if (vals.includes("flaky")) c.category = "flaky";
    else if (vals.includes("skipped")) c.category = "skipped";
    else if (errLr?.tests[t.id]?.repairable) c.category = "unrepairable";
    else if (run2.mode === "bugfix") {
      const F = passed(outcomes.fixed);
      const B = passed(outcomes.buggy);
      c.category = F && !B ? "effective" : !F && B ? "misguided" : F && B ? "neutral" : "broken";
    } else c.category = passed(outcomes.current) ? "accepted" : "disputed";
    tests.push(c);
    if (c.category === "flaky") dropped.push({ id: c.id, target: c.target, reason: "flaky across reruns" });
    if (c.category === "unrepairable") dropped.push({ id: c.id, target: c.target, reason: "setup/import error after repair rounds" });
    if (c.category === "misguided" || c.category === "broken") {
      queue2.push({ test: c.id, category: c.category, reason: c.category === "misguided" ? "fails on the fixed revision but passes on the buggy one" : "fails on both revisions", revision: "fixed" });
    }
    if (c.category === "disputed") queue2.push({ test: c.id, category: c.category, reason: "fails on the current code", revision: "current" });
  }
  if (run2.mode === "audit") {
    const existing = tests.filter((t) => t.existing && t.category === "accepted");
    for (const qi of queue2) {
      const bt = tests.find((t) => t.id === qi.test);
      const target = loadTarget(repo, runId, bt.target);
      const unit = target.symbol.split(/[.:#]/).pop();
      const re = new RegExp(`\\b${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      const pair = existing.filter((e) => re.test(fs14.readFileSync(`${repo.root}/${e.file}`, "utf8"))).map((e) => e.id);
      if (pair.length) {
        qi.pair = pair;
        qi.reason += `; existing test(s) on the same unit pass: ${pair.map((p) => p.split("::").pop()).join(", ")}`;
      }
    }
  }
  let kill_rate;
  if (res.mutants) {
    kill_rate = {};
    const killers = new Set(Object.values(res.mutants).flatMap((m) => m.killed_by));
    for (const t of tests) if (t.category === "accepted" && killers.has(t.id)) t.extra = [...t.extra ?? [], "effective"];
    for (const tid of run2.targets) {
      const file = loadTarget(repo, runId, tid).file;
      const ms = Object.values(res.mutants).filter((m) => m.file === file);
      kill_rate[tid] = { killed: ms.filter((m) => m.killed_by.length).length, total: ms.length };
    }
  }
  const counts2 = {};
  for (const t of tests) {
    const k = t.existing ? "existing" : t.target;
    counts2[k] ??= {};
    counts2[k][t.category] = (counts2[k][t.category] ?? 0) + 1;
  }
  const out = { run: runId, exec: res.exec, mode: run2.mode, at: nowIso(), tests, queue: queue2, counts: counts2, dropped, ...kill_rate ? { kill_rate } : {} };
  writeJson(runDir(repo, runId, "classification.json"), out);
  repo.ledger("classified", { run: runId, exec: res.exec, counts: counts2, queued: queue2.length });
  return out;
}
function loadClassification(repo, runId) {
  const f = runDir(repo, runId, "classification.json");
  return fs14.existsSync(f) ? readJson(f) : null;
}
var passed;
var init_classify = __esm({
  "src/classify.ts"() {
    "use strict";
    init_exec();
    init_run();
    init_util();
    passed = (o) => o === "pass";
  }
});

// src/verdicts.ts
import * as fs15 from "node:fs";
function loadVerdicts(repo, runId) {
  return readJson(runDir(repo, runId, "verdicts.json"), {});
}
function saveVerdicts(repo, runId, v) {
  writeJson(runDir(repo, runId, "verdicts.json"), v);
}
function effective(e) {
  return e?.override ?? e?.model;
}
function unresolved(repo, runId) {
  const run2 = loadRun(repo, runId);
  const verdicts = loadVerdicts(repo, runId);
  const resultsFile = runDir(repo, runId, "results.json");
  const results = fs15.existsSync(resultsFile) ? readJson(resultsFile) : null;
  const ledger = repo.readLedger().filter((e) => e.run === runId);
  const out = [];
  for (const [test, entry] of Object.entries(verdicts)) {
    const v = effective(entry);
    if (!v || v.verdict === "test-wrong") continue;
    const target = test.split("::")[0];
    if (v.verdict === "code-wrong") {
      const lr = results?.labels[ERRORS_LABEL[run2.mode]];
      const fixedNow = results && results.at > v.at && lr?.tests[test]?.final === "pass";
      if (fixedNow) continue;
    } else {
      if (entry.override) continue;
      const edit = ledger.find((e) => e.type === "spec_edited" && e.target === target && e.ts > v.at);
      if (edit && ledger.some((e) => e.type === "tests_submitted" && e.target === target && e.ts > edit.ts)) continue;
    }
    out.push({ run: runId, test, target, verdict: v.verdict, reason: v.reason, spec_basis: v.spec_basis });
  }
  return out;
}
function openRuns(repo) {
  return listRuns(repo).filter((r) => r.status === "open").map((r) => r.id);
}
var VERDICTS;
var init_verdicts = __esm({
  "src/verdicts.ts"() {
    "use strict";
    init_run();
    init_util();
    VERDICTS = ["code-wrong", "test-wrong", "spec-ambiguous"];
  }
});

// src/adjudicate.ts
import * as fs16 from "node:fs";
import * as path13 from "node:path";
function queue(repo, runId) {
  const cls2 = loadClassification(repo, runId);
  if (!cls2) throw usage(`run \`tcheck classify ${runId}\` first`);
  const v = loadVerdicts(repo, runId);
  return cls2.queue.map((q2) => {
    const e = effective(v[q2.test]);
    return { ...q2, status: e ? "decided" : "pending", ...e ? { verdict: e.verdict, source: e.source } : {} };
  });
}
function mapRange(repo, from, to, file, [a, b]) {
  if (from === to) return [a, b];
  const diff = repo.git(["diff", "-U0", from, to, "--", file], { allowFail: true });
  const map = (x, end) => {
    let delta = 0;
    for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const [os4, ol, ns, nl] = [+m[1], m[2] === void 0 ? 1 : +m[2], +m[3], m[4] === void 0 ? 1 : +m[4]];
      if (ol === 0) {
        if (x > os4 || end && x === os4) delta += nl;
        else break;
      } else if (x > os4 + ol - 1) delta += nl - ol;
      else if (x >= os4) return end ? ns + Math.max(nl, 1) - 1 : ns;
      else break;
    }
    return x + delta;
  };
  const s = map(a, false);
  return [s, Math.max(s, map(b, true))];
}
function bodyAt(repo, t, commit) {
  if (commit === t.commit) return t.body;
  const [a, b] = mapRange(repo, t.commit, commit, t.file, t.lines);
  const lines = fileAt(repo, commit, t.file).split(/\r?\n/);
  return lines.slice(a - 1, b).join("\n");
}
function queued(repo, runId, testId) {
  const cls2 = loadClassification(repo, runId);
  const q2 = cls2?.queue.find((x) => x.test === testId);
  if (!q2) throw usage(`${testId} is not queued for adjudication in ${runId} (see \`tcheck adjudicate queue ${runId}\`)`);
  return q2;
}
function composedSource(repo, runId, file) {
  const composed = runDir(repo, runId, "composed", file);
  if (fs16.existsSync(composed)) return fs16.readFileSync(composed, "utf8");
  return fs16.readFileSync(path13.join(repo.root, file), "utf8");
}
function adjudicatePrompt(repo, runId, testId) {
  const run2 = loadRun(repo, runId);
  const q2 = queued(repo, runId, testId);
  const results = loadResults(repo, runId);
  const label = ERRORS_LABEL[run2.mode];
  const tr = results.labels[label]?.tests[testId];
  const anyTr = tr ?? Object.values(results.labels).map((l) => l.tests[testId]).find(Boolean);
  if (!anyTr) throw usage(`no results for ${testId}`);
  const targetId2 = testId.split("::")[0];
  const t = loadTarget(repo, runId, targetId2);
  let testSource = composedSource(repo, runId, anyTr.file);
  for (const pair of q2.pair ?? []) {
    const ex = results.labels[label].tests[pair];
    if (ex) testSource += `

# --- existing test ${ex.name} (${ex.file}), which PASSES on the current code ---
${composedSource(repo, runId, ex.file)}`;
  }
  const failure = tr ? [`Test: ${tr.name} (${tr.file})`, `Outcome on ${label}: ${tr.final}`, [tr.type, tr.message].filter(Boolean).join(": "), tr.text ?? ""].filter(Boolean).join("\n") : `Test: ${anyTr.name} produced no result on ${label} (${results.labels[label]?.timed_out.length ? "timeout" : "not collected"}).`;
  const commit = run2.revisions[label];
  const analysisFile = runDir(repo, runId, "targets", targetId2, "analysis.md");
  const vars = {
    ...configVars(repo, t),
    spec: loadSpec(repo, runId, targetId2) ?? "(no spec saved)",
    analysis: fs16.existsSync(analysisFile) ? fs16.readFileSync(analysisFile, "utf8").trim() : "",
    test_source: testSource.trimEnd(),
    failure_output: failure.slice(0, 8e3),
    target: { symbol: t.symbol, file: t.file, body: bodyAt(repo, t, commit) },
    revision: `${label} (${commit.slice(0, 10)})`
  };
  const body = renderPrompt("adjudicate.md", vars, "adjudicate");
  return storePayload(repo, { role: "adjudicate", run: runId, target: targetId2, test: testId }, body);
}
function parseVerdict(raw) {
  const v = (tag2(raw, "verdict") ?? "").toLowerCase().replace(/[`*]/g, "").trim();
  if (!VERDICTS.includes(v)) throw rejected(`<verdict> must be exactly one of ${VERDICTS.join(", ")}; got "${v || "(missing)"}"`);
  const spec_basis = tag2(raw, "spec_basis") ?? "none";
  const reason = tag2(raw, "reason") ?? "";
  if (v === "code-wrong" && /^(none|n\/a|)$/i.test(spec_basis.replace(/["'.]/g, "").trim())) {
    return { verdict: "spec-ambiguous", spec_basis, reason, warning: "code-wrong without a quoted spec sentence was downgraded to spec-ambiguous" };
  }
  return { verdict: v, spec_basis, reason };
}
function applyQuarantine(repo, testId, on) {
  repo.updateState((s) => {
    s.quarantined = s.quarantined.filter((q2) => q2 !== testId);
    if (on) s.quarantined.push(testId);
  });
}
function adjudicateSave(repo, runId, testId, raw) {
  queued(repo, runId, testId);
  const p = parseVerdict(raw);
  const v = { ...p, source: "model", at: nowIso() };
  const all = loadVerdicts(repo, runId);
  all[testId] = { ...all[testId], model: v };
  saveVerdicts(repo, runId, all);
  if (!all[testId].override) applyQuarantine(repo, testId, v.verdict === "test-wrong");
  repo.ledger("verdict", { run: runId, test: testId, verdict: v.verdict, spec_basis: v.spec_basis, ...v.warning ? { warning: v.warning } : {} });
  return { test: testId, ...v, message: `Verdict recorded: ${v.verdict} for ${testId}.${v.warning ? ` Warning: ${v.warning}.` : ""}` };
}
function adjudicateOverride(repo, runId, testId, verdict, reason) {
  if (!VERDICTS.includes(verdict)) throw usage(`--verdict must be one of ${VERDICTS.join(", ")}`);
  if (!reason) throw usage("override needs --reason");
  loadRun(repo, runId);
  const v = { verdict, spec_basis: "user decision", reason, source: "user", at: nowIso() };
  const all = loadVerdicts(repo, runId);
  all[testId] = { ...all[testId], override: v };
  saveVerdicts(repo, runId, all);
  applyQuarantine(repo, testId, v.verdict === "test-wrong");
  repo.ledger("override", { run: runId, test: testId, verdict, reason });
  return { test: testId, ...v, message: `Override recorded: ${verdict} for ${testId}.` };
}
var tag2;
var init_adjudicate = __esm({
  "src/adjudicate.ts"() {
    "use strict";
    init_classify();
    init_exec();
    init_run();
    init_payload();
    init_spec();
    init_verdicts();
    init_util();
    tag2 = (text, name) => {
      const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(text);
      return m ? m[1].trim() : null;
    };
  }
});

// src/hooks.ts
import * as fs17 from "node:fs";
import * as path14 from "node:path";
function normalize2(event, raw) {
  const input = raw?.tool_input ?? raw?.input;
  return {
    event,
    tool: raw?.tool_name ?? raw?.tool,
    input,
    subagent: input?.subagent_type ?? input?.agent ?? raw?.subagent,
    agentType: raw?.agent_type,
    stopHookActive: !!(raw?.stop_hook_active ?? raw?.stopHookActive),
    cwd: raw?.cwd ?? process.cwd()
  };
}
function repoFor(ev, root) {
  const r = findRoot({ root, cwd: ev.cwd, gitFallback: false });
  if (!r || !fs17.existsSync(path14.join(r, STATE_DIR, "config.yaml"))) return null;
  return new Repo(r);
}
function touchHooksSeen(repo) {
  const seen = repo.state().hooks_seen_at;
  if (!seen || Date.now() - Date.parse(seen) > 3600 * 1e3) repo.updateState((s) => s.hooks_seen_at = nowIso());
}
function editedPaths(input) {
  const out = [];
  const visit = (v, key) => {
    if (typeof v === "string") {
      if (key === "file_path" || key === "notebook_path" || key === "filePath" || key === "path") out.push(v);
      for (const m of v.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) out.push(m[1]);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(input);
  return [...new Set(out)];
}
function protectGlobs(repo) {
  const c = repo.config;
  const pat = c.test_file_pattern.replace(/\{[^}]+\}/g, "*");
  const dirGlob = (d) => d.replace(/\{(pkg_dir|package_path)\}/g, "**").replace(/\{[^}]+\}/g, "*").replace(/\/+$/, "");
  const globs = [...c.protect, `${STATE_DIR}/generated/**`, path14.posix.join(dirGlob(c.test_dir), pat)];
  if (c.promote_dir) globs.push(path14.posix.join(dirGlob(c.promote_dir), pat));
  return globs;
}
function protectTests(repo, ev) {
  if (process.env.TCHECK_ALLOW_TEST_EDITS === "1") return { action: "allow" };
  const state = repo.state();
  const quarantined = new Set(state.quarantined);
  const globs = protectGlobs(repo);
  for (const p of editedPaths(ev.input)) {
    const rel = toPosix(path14.isAbsolute(p) ? path14.relative(repo.root, p) : p).replace(/^\.\//, "");
    if (rel.startsWith("..")) continue;
    const entry = state.protected[rel];
    if (!entry && !matchGlobs(rel, globs)) continue;
    const stem = path14.posix.basename(rel).split(".")[0];
    const ids = entry?.test_ids ?? [...quarantined].filter((q2) => q2.split("::")[1]?.split(".").includes(stem));
    if (ids.some((id) => quarantined.has(id))) continue;
    const what = entry ? `verified test(s) ${ids.map((i) => i.split("::").pop()).join(", ")}` : rel.startsWith(`${STATE_DIR}/generated/`) ? "a generated blind test" : "a protected test file";
    return {
      action: "deny",
      reason: `${rel} is ${what}. Don't edit tests to make them pass: send the failing test to adjudication (\`tcheck adjudicate prompt <run> <test>\`), or ask the user. A test-wrong verdict or \`tcheck adjudicate override\` unlocks it.`
    };
  }
  return { action: "allow" };
}
function handoffGuard(repo, ev) {
  const role = ev.subagent ? BLIND_AGENTS[ev.subagent] : void 0;
  if (!role) return { action: "allow" };
  const prompt = String(ev.input?.prompt ?? "").trim();
  const f = parseFrame(prompt);
  if (!f) return { action: "deny", reason: HANDOFF_DENY };
  const { entry, full } = loadPayload(repo, f.id);
  if (entry.role !== role || entry.consumed || full.trim() !== prompt) return { action: "deny", reason: HANDOFF_DENY };
  return { action: "allow" };
}
function stopGate(repo, ev) {
  const gate = process.env.TCHECK_GATE === "off" ? "off" : repo.config.gate;
  if (gate === "off") return { action: "allow" };
  const dirty = dirtyFiles(repo);
  if (!dirty.length) return { action: "allow" };
  const list2 = dirty.slice(0, 10).join(", ") + (dirty.length > 10 ? `, \u2026 (${dirty.length - 10} more)` : "");
  const msg = `${dirty.length} changed source file(s) are unverified: ${list2}. Run the verify-tests skill, or ask the user to waive.`;
  if (gate === "block" && !ev.stopHookActive) return { action: "block", reason: msg };
  return { action: "warn", message: msg };
}
function sessionStart(repo) {
  const n = dirtyFiles(repo).length;
  return {
    action: "context",
    text: `test-checker is active (gate: ${repo.config.gate}).${n ? ` ${n} source file(s) changed since last verification. Use the verify-tests skill before finishing work on them.` : ""}`
  };
}
function evaluateHook(ev, opts = {}) {
  let repo = null;
  try {
    repo = repoFor(ev, opts.root);
    if (!repo) return { action: "allow" };
    touchHooksSeen(repo);
    let d;
    switch (ev.event) {
      case "session-start":
        d = sessionStart(repo);
        break;
      case "handoff-guard":
        d = handoffGuard(repo, ev);
        break;
      case "protect-tests":
        d = protectTests(repo, ev);
        break;
      case "stop-gate":
        d = stopGate(repo, ev);
        break;
      default:
        d = { action: "allow" };
    }
    if (d.action === "deny" || d.action === "block") repo.ledger("hook_blocked", { event: ev.event, reason: d.reason });
    return d;
  } catch (e) {
    process.stderr.write(`tcheck hook ${ev.event}: internal error: ${e?.message ?? e}
`);
    if (ev.event === "handoff-guard") {
      try {
        repo?.ledger("hook_blocked", { event: ev.event, reason: `internal error: ${e?.message ?? e}` });
      } catch {
      }
      return { action: "deny", reason: `${HANDOFF_DENY} (${e?.message ?? e})` };
    }
    return { action: "allow" };
  }
}
function hookOutput(d, harness) {
  void harness;
  switch (d.action) {
    case "deny":
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } }), stderr: "" };
    case "block":
      return { stdout: JSON.stringify({ decision: "block", reason: d.reason }), stderr: "" };
    case "warn":
      return { stdout: JSON.stringify({ systemMessage: d.message }), stderr: "" };
    case "context":
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: d.text } }), stderr: "" };
    default:
      return { stdout: "", stderr: "" };
  }
}
async function runHookCli(event, harnessFlag, root) {
  if (!HOOK_EVENTS.includes(event)) {
    process.stderr.write(`tcheck hook: unknown event ${event}
`);
    return;
  }
  let raw = {};
  try {
    const text = fs17.readFileSync(0, "utf8");
    raw = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    if (event === "handoff-guard") {
      process.stdout.write(hookOutput({ action: "deny", reason: `${HANDOFF_DENY} (unreadable hook input)` }, "claude-code").stdout + "\n");
      return;
    }
    process.stderr.write(`tcheck hook ${event}: unreadable input: ${e?.message ?? e}
`);
    return;
  }
  debugLog({ hook: event, input: raw });
  const d = evaluateHook(normalize2(event, raw), { root });
  const out = hookOutput(d, detectHarness(harnessFlag));
  if (out.stdout) process.stdout.write(out.stdout + "\n");
  if (out.stderr) process.stderr.write(out.stderr + "\n");
}
function debugLog(entry) {
  const f = process.env.TCHECK_DEBUG_LOG;
  if (!f) return;
  try {
    fs17.appendFileSync(f, JSON.stringify({ ts: nowIso(), pid: process.pid, ...entry }) + "\n");
  } catch {
  }
}
var HOOK_EVENTS, BLIND_AGENTS, HANDOFF_DENY;
var init_hooks = __esm({
  "src/hooks.ts"() {
    "use strict";
    init_repo();
    init_dirty();
    init_payload();
    init_util();
    init_env();
    HOOK_EVENTS = ["session-start", "handoff-guard", "protect-tests", "stop-gate"];
    BLIND_AGENTS = {
      "test-checker:tcheck-blind-writer": "writer",
      "test-checker:tcheck-repair": "repair",
      "tcheck-blind-writer": "writer",
      "tcheck-repair": "repair"
    };
    HANDOFF_DENY = "Blind roles must receive the exact output of `tcheck bundle emit`. Re-emit and pass it verbatim.";
  }
});

// src/mcp.ts
import * as readline from "node:readline";
function openRepo() {
  const root = findRoot({});
  if (!root) throw envMissing("test-checker could not find the repository (CLAUDE_PROJECT_DIR is unset and cwd is not in a git repo)");
  return Repo.open({ root });
}
function callTool(name, args, repo = openRepo()) {
  const id = String(args?.payload_id ?? "");
  switch (name) {
    case "submit_tests":
      return submitTests(repo, id, args.files, args.notes).message;
    case "save_spec": {
      const { entry } = loadPayload(repo, id);
      requireRole(entry, ["spec"]);
      specSave(repo, entry.run, entry.target, String(args.raw_output ?? ""));
      return `Spec saved for ${entry.target}. Leak check: passed.`;
    }
    case "save_verdict": {
      const { entry } = loadPayload(repo, id);
      requireRole(entry, ["adjudicate"]);
      return adjudicateSave(repo, entry.run, entry.test, String(args.raw_output ?? "")).message;
    }
    default:
      throw new TcheckError(`unknown tool: ${name}`);
  }
}
function handle(msg) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const isRequest = msg.id !== void 0 && msg.id !== null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tcheck", version: "0.1.0" },
        instructions: "test-checker's internal role tools. Only the test-checker subagents should call these."
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      debugLog({ mcp: "call", name });
      try {
        return reply({ content: [{ type: "text", text: callTool(name, args ?? {}) }], isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `ERROR: ${e?.message ?? e}` }], isError: true });
      }
    }
    default:
      if (!isRequest) return void 0;
      if (msg.method === "resources/list") return reply({ resources: [] });
      if (msg.method === "prompts/list") return reply({ prompts: [] });
      return fail(-32601, `method not found: ${msg.method}`);
  }
}
function serve() {
  debugLog({ mcp: "start", cwd: process.cwd(), CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null, CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null });
  return new Promise((resolve3) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
        return;
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) {
        const out = handle(m);
        if (out) process.stdout.write(JSON.stringify(out) + "\n");
      }
    });
    rl.on("close", () => resolve3());
  });
}
var PROTOCOLS, INTERNAL, TOOLS;
var init_mcp = __esm({
  "src/mcp.ts"() {
    "use strict";
    init_repo();
    init_bundle();
    init_spec();
    init_adjudicate();
    init_payload();
    init_util();
    init_hooks();
    PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
    INTERNAL = "For test-checker's internal roles only; never call this yourself.";
    TOOLS = [
      {
        name: "submit_tests",
        description: `Submit the unit test files written for a test-checker payload. ${INTERNAL} Blind writer and repair roles call it once, with the payload_id from their payload header.`,
        inputSchema: {
          type: "object",
          properties: {
            payload_id: { type: "string", description: "The id from the <<<TCHECK-PAYLOAD header, e.g. p-1c9e04ab" },
            files: {
              type: "array",
              description: "Complete test files. `path` is a plain file name following the naming pattern in the payload (no directories).",
              items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
            },
            notes: { type: "string", description: "Optional: spec ambiguities noticed" }
          },
          required: ["payload_id", "files"]
        }
      },
      {
        name: "save_spec",
        description: `Save the spec-extractor's answer (the <analysis> and <spec> blocks) for a test-checker payload. ${INTERNAL}`,
        inputSchema: {
          type: "object",
          properties: { payload_id: { type: "string" }, raw_output: { type: "string", description: "The complete answer, including <analysis> and <spec>" } },
          required: ["payload_id", "raw_output"]
        }
      },
      {
        name: "save_verdict",
        description: `Save the adjudicator's verdict (<verdict>, <spec_basis>, <reason>) for a test-checker payload. ${INTERNAL}`,
        inputSchema: {
          type: "object",
          properties: { payload_id: { type: "string" }, raw_output: { type: "string", description: "The complete answer, including <verdict>, <spec_basis> and <reason>" } },
          required: ["payload_id", "raw_output"]
        }
      }
    ];
  }
});

// src/backends.ts
var backends_exports = {};
__export(backends_exports, {
  backendOpts: () => backendOpts,
  blindRun: () => blindRun,
  childEnv: () => childEnv,
  firstHeadless: () => firstHeadless,
  runBackend: () => runBackend
});
import { spawn as spawn2 } from "node:child_process";
import * as fs18 from "node:fs";
import * as os3 from "node:os";
import * as path15 from "node:path";
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return env;
}
function spawnText(cmd, args, opts) {
  return new Promise((resolve3) => {
    const child = spawn2(cmd, args, { cwd: opts.cwd, env: childEnv(), windowsHide: true, shell: isWin, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.stdin.on("error", () => {
    });
    child.stdin.end(opts.input ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutSec * 1e3);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve3({ code: 127, stdout, stderr: stderr + e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve3({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}
function opencodeConfig() {
  const deny = Object.fromEntries(["edit", "bash", "webfetch", "websearch", "read", "glob", "grep", "list", "task", "todowrite", "todoread", "skill", "external_directory", "lsp"].map((k) => [k, "deny"]));
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", agent: { "tcheck-blind-writer": { mode: "primary", description: "test-checker blind role (no tools)", permission: deny, tools: { "*": false } } } }, null, 2);
}
async function runBackend(backend, prompt, opts = {}) {
  const timeoutSec = opts.timeoutSec ?? 900;
  if (backend === "api") return apiCall(prompt, opts);
  if (!["claude", "codex", "opencode", "pi"].includes(backend)) throw usage(`backend ${backend} cannot run headless prompts`);
  if (!which(backend)) throw envMissing(`backend ${backend} is not installed (not on PATH)`);
  const tmp = fs18.realpathSync(fs18.mkdtempSync(path15.join(os3.tmpdir(), "tcheck-blind-")));
  try {
    fs18.writeFileSync(path15.join(tmp, "PROMPT.md"), prompt);
    let args;
    let input;
    let outFile;
    const model = opts.model ? [opts.model] : [];
    switch (backend) {
      case "claude":
        args = ["-p", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", ...model.length ? ["--model", ...model] : []];
        input = prompt;
        break;
      case "codex":
        outFile = path15.join(tmp, "..", `${path15.basename(tmp)}-last.md`);
        args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-C", tmp, "-o", outFile, ...model.length ? ["-m", ...model] : [], "-"];
        input = prompt;
        break;
      case "opencode":
        fs18.writeFileSync(path15.join(tmp, "opencode.json"), opencodeConfig());
        args = ["run", "--agent", "tcheck-blind-writer", "--dir", tmp, ...model.length ? ["-m", ...model] : [], prompt];
        break;
      default:
        args = ["-p", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--offline", ...model.length ? ["--model", ...model] : [], prompt];
    }
    const r = await spawnText(backend, args, { cwd: tmp, input, timeoutSec });
    if (r.timedOut) throw new TcheckError(`${backend} timed out after ${timeoutSec}s`, EXIT.COMMAND);
    if (r.code !== 0) throw new TcheckError(`${backend} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-800)}`, EXIT.COMMAND);
    const text = outFile && fs18.existsSync(outFile) ? fs18.readFileSync(outFile, "utf8") : r.stdout;
    if (outFile) fs18.rmSync(outFile, { force: true });
    if (!text.trim()) throw new TcheckError(`${backend} returned no text${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").slice(-3).join(" | ").slice(-600)}` : ""}`, EXIT.COMMAND);
    return text;
  } finally {
    fs18.rmSync(tmp, { recursive: true, force: true });
  }
}
async function apiCall(prompt, opts) {
  const api = opts.api;
  if (!api?.model) throw usage("blind.backend: api needs blind.api.model");
  const key = process.env[api.key_env];
  if (!key) throw envMissing(`blind.backend: api needs the ${api.key_env} environment variable`);
  const res = api.provider === "openai" ? await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: api.model, input: prompt })
  }) : await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: api.model, max_tokens: 16e3, messages: [{ role: "user", content: prompt }] })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new TcheckError(`${api.provider} API ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`, EXIT.COMMAND);
  const text = api.provider === "openai" ? body.output_text ?? (body.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("") : (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  if (!text?.trim()) throw new TcheckError(`${api.provider} API returned no text`, EXIT.COMMAND);
  return text;
}
function backendOpts(repo) {
  const c = repo.config;
  return { model: c.blind.model, api: c.blind.api, timeoutSec: Math.max(c.timeouts.per_command_seconds, 300) };
}
async function blindRun(repo, bundle, role, opts = {}) {
  const harness = detectHarness(opts.harness);
  const backend = opts.backend ? opts.backend : resolveBackend(repo.config.blind.backend, harness, repo.config.blind.api.key_env);
  if (backend === "native") {
    throw new TcheckError(
      `blind-run is for harnesses without a native blind role. In ${harness}, launch the blind subagent with \`tcheck bundle emit\` (see the harness reference), or pass --backend claude|codex|opencode|pi.`,
      EXIT.USAGE
    );
  }
  if (backend === "none") throw envMissing("no blind backend available: install claude, codex, opencode or pi (each runs on its own subscription login), or opt in to blind.backend: api");
  loadBundle(repo, bundle);
  const p = bundleEmit(repo, bundle, role, { run: opts.run, via: "text" });
  const text = await runBackend(backend, p.full, backendOpts(repo));
  writeText(path15.join(runDir(repo, loadBundle(repo, bundle).meta.run_id, "blind"), `${p.payload}.out.md`), text);
  const r = ingest(repo, p.payload, text);
  return { ...r, backend, isolation: ISOLATION[backend], payload: p.payload };
}
var STRIP;
var init_backends = __esm({
  "src/backends.ts"() {
    "use strict";
    init_env();
    init_bundle();
    init_run();
    init_util();
    STRIP = /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|HOST_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SDK_HAS_HOST_AUTH_REFRESH|SESSION_ATTENDED|EMIT_TOOL_USE_SUMMARIES|REPORT_FINDINGS|TERMINAL_MCP_TOOLS)|CLAUDE_PID|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_AGENT_SDK_VERSION|PLUGIN_ROOT|TCHECK_HARNESS|CODEX_THREAD_ID|CODEX_SANDBOX.*)$/;
  }
});

// src/lib.ts
var init_lib = __esm({
  "src/lib.ts"() {
    "use strict";
    init_repo();
    init_env();
    init_yaml();
    init_schema();
    init_util();
    init_fixtures();
    init_junit();
    init_leak();
    init_repair();
    init_payload();
    init_bundle();
    init_spec();
    init_adjudicate();
    init_hooks();
    init_mcp();
    init_backends();
    init_spec();
    init_bundle();
    init_adjudicate();
  }
});

// src/status.ts
var status_exports = {};
__export(status_exports, {
  status: () => status
});
function status(repo) {
  const dirty = dirtyFiles(repo);
  const runs = openRuns(repo);
  const open = runs.flatMap((r) => unresolved(repo, r));
  const data = { gate: repo.config.gate, dirty_files: dirty, open_runs: runs, unresolved_verdicts: open };
  const human = [
    `gate: ${data.gate}`,
    `unverified source files: ${dirty.length ? dirty.join(", ") : "none"}`,
    `open runs: ${runs.length ? runs.join(", ") : "none"}`,
    ...open.length ? ["unresolved verdicts:", ...open.map((u) => `  ${u.verdict}: ${u.test} (${u.run})`)] : ["unresolved verdicts: none"]
  ].join("\n");
  return { data, human };
}
var init_status = __esm({
  "src/status.ts"() {
    "use strict";
    init_dirty();
    init_verdicts();
  }
});

// src/promote.ts
import * as fs19 from "node:fs";
import * as path16 from "node:path";
function planPromotion(repo, runId, opts = {}) {
  const run2 = loadRun(repo, runId);
  const cls2 = loadClassification(repo, runId);
  if (!cls2) throw usage(`run \`tcheck classify ${runId}\` first`);
  const cfg = repo.config;
  const quarantined = new Set(repo.state().quarantined);
  const composed = readJson(runDir(repo, runId, "composed.json"), { files: [] }).files;
  const acceptable = new Set(run2.mode === "bugfix" ? ["effective", "neutral"] : ["accepted"]);
  const selected = (t) => opts.tests?.length ? opts.tests.includes(t.id) : opts.allAccepted ? acceptable.has(t.category) : run2.mode === "bugfix" ? t.category === "effective" : t.category === "accepted";
  const files = [];
  const skipped = [];
  for (const f of composed) {
    const tests = cls2.tests.filter((t2) => t2.file === f.path && !t2.existing);
    if (!tests.length) {
      skipped.push({ file: f.path, reason: "no test results" });
      continue;
    }
    const bad = tests.filter((t2) => !acceptable.has(t2.category) || quarantined.has(t2.id));
    if (bad.length) {
      skipped.push({ file: f.path, reason: `contains non-accepted tests: ${bad.map((t2) => `${t2.name} (${quarantined.has(t2.id) ? "quarantined" : t2.category})`).join(", ")}` });
      continue;
    }
    if (!tests.some(selected)) {
      skipped.push({ file: f.path, reason: run2.mode === "bugfix" ? "only neutral tests (use --all-accepted to include)" : "not selected" });
      continue;
    }
    if (!cfg.promote_dir) throw new TcheckError("promote_dir is not set in .test-checker/config.yaml", EXIT.USAGE);
    const t = loadTarget(repo, runId, f.target);
    files.push({ source: f.path, dest: path16.posix.join(expandPath(cfg.promote_dir, t), path16.posix.basename(f.path)), target: f.target, tests: tests.map((x) => x.id) });
  }
  return { files, skipped };
}
function promote(repo, runId, opts = {}) {
  const run2 = loadRun(repo, runId);
  const blocking = unresolved(repo, runId);
  if (blocking.length && !opts.force) {
    throw new TcheckError(
      `refusing to promote: unresolved verdicts
${blocking.map((b) => `  ${b.verdict}: ${b.test}`).join("\n")}
Fix the code and re-run exec (code-wrong), or ask the user and record \`tcheck adjudicate override\` / \`tcheck spec edit\` (spec-ambiguous). --force skips this check.`,
      EXIT.REJECTED
    );
  }
  const plan = planPromotion(repo, runId, opts);
  if (!plan.files.length) return { promoted: [], skipped: plan.skipped, verified: [] };
  for (const f of plan.files) {
    const dest = path16.join(repo.root, f.dest);
    const content = fs19.readFileSync(runDir(repo, runId, "composed", f.source), "utf8");
    if (fs19.existsSync(dest) && fs19.readFileSync(dest, "utf8") !== content && !opts.force) {
      throw new TcheckError(`${f.dest} already exists with different content (--force to overwrite)`, EXIT.REJECTED);
    }
    writeText(dest, content);
  }
  const commit = run2.revisions[ERRORS_LABEL[run2.mode]];
  const verified = [];
  const at = nowIso();
  repo.updateState((s) => {
    for (const f of plan.files) s.protected[f.dest] = { test_ids: f.tests, run: runId };
    for (const tid of run2.targets) {
      const file = loadTarget(repo, runId, tid).file;
      const sha = repo.git(["rev-parse", `${commit}:${file}`], { allowFail: true }).trim();
      if (sha) {
        s.verified[file] = { sha, run: runId, at };
        verified.push(file);
      }
    }
  });
  repo.ledger("promoted", { run: runId, files: plan.files.map((f) => f.dest), verified });
  return { promoted: plan.files, skipped: plan.skipped, verified };
}
var init_promote = __esm({
  "src/promote.ts"() {
    "use strict";
    init_classify();
    init_run();
    init_verdicts();
    init_util();
  }
});

// src/report.ts
import * as fs20 from "node:fs";
function buildReport(repo, runId, opts = {}) {
  const run2 = loadRun(repo, runId);
  const cls2 = loadClassification(repo, runId);
  if (!cls2) throw usage(`run \`tcheck classify ${runId}\` first`);
  const results = loadResults(repo, runId);
  const verdicts = loadVerdicts(repo, runId);
  const harness = detectHarness(opts.harness);
  const backend = resolveBackend(repo.config.blind.backend, harness, repo.config.blind.api.key_env);
  const quarantined = new Set(repo.state().quarantined);
  const cats = run2.mode === "bugfix" ? ["effective", "misguided", "neutral", "broken"] : ["accepted", "disputed"];
  const summary = run2.targets.map((tid) => {
    const c = cls2.counts[tid] ?? {};
    return {
      target: tid,
      ...Object.fromEntries(cats.map((k) => [k, c[k] ?? 0])),
      flaky: c.flaky ?? 0,
      dropped: cls2.dropped.filter((d) => d.target === tid).length,
      ...cls2.kill_rate?.[tid] ? { mutant_kill_rate: `${cls2.kill_rate[tid].killed}/${cls2.kill_rate[tid].total}` } : {}
    };
  });
  const testOf = (id) => cls2.tests.find((t) => t.id === id);
  const failureOf = (id) => {
    for (const lr of Object.values(results.labels)) {
      const t = lr.tests[id];
      if (t && t.final !== "pass") return [t.type, t.message].filter(Boolean).join(": ").slice(0, 300);
    }
    return "";
  };
  const decided = Object.entries(verdicts).map(([test, e]) => ({ test, v: effective(e) })).filter((x) => x.v);
  const likely_bugs = decided.filter((d) => d.v.verdict === "code-wrong").map((d) => {
    const q2 = cls2.queue.find((x) => x.test === d.test);
    return { test: d.test, target: d.test.split("::")[0], spec_basis: d.v.spec_basis, failure: failureOf(d.test), reason: d.v.reason, ...q2?.pair?.length ? { suspect_existing: q2.pair } : {} };
  });
  const suspicions = run2.targets.map((tid) => {
    const f = runDir(repo, runId, "targets", tid, "analysis.md");
    return { target: tid, analysis: fs20.existsSync(f) ? fs20.readFileSync(f, "utf8").trim() : "" };
  }).filter((s) => s.analysis && !/^(logical mistakes:\s*none found\.?\s*robustness omissions:\s*none found\.?)$/i.test(s.analysis.replace(/\s+/g, " ")));
  const decisions = decided.filter((d) => d.v.verdict === "spec-ambiguous" && !verdicts[d.test].override).map((d) => ({ test: d.test, question: d.v.reason, spec_basis: d.v.spec_basis }));
  const misguided = cls2.tests.filter((t) => t.category === "misguided" || t.category === "disputed").map((t) => {
    const e = effective(verdicts[t.id]);
    return { test: t.id, category: t.category, outcome: e ? `${e.verdict}${e.source === "user" ? " (user)" : ""}` : "pending adjudication" };
  });
  const dropped = [
    ...cls2.dropped.map((d) => ({ what: d.id ? short(d.id) : d.file, target: d.target, reason: d.reason })),
    ...[...quarantined].filter((q2) => testOf(q2)).map((q2) => ({ what: short(q2), target: q2.split("::")[0], reason: "quarantined (test-wrong)" }))
  ];
  const plan = planPromotion(repo, runId, { allAccepted: false });
  const data = {
    run: runId,
    mode: run2.mode,
    revisions: Object.fromEntries(Object.entries(run2.revisions).map(([l, sha]) => [l, { given: run2.given[l], commit: sha }])),
    date: nowIso(),
    harness,
    blind_isolation: ISOLATION[backend],
    summary,
    likely_bugs,
    suspicions,
    needs_decision: decisions,
    misguided,
    dropped,
    promotable: plan.files.map((f) => ({ file: f.source, dest: f.dest, tests: f.tests.length })),
    not_promotable: plan.skipped
  };
  return data;
}
function table(rows) {
  if (!rows.length) return "_none_";
  const cols = Object.keys(rows[0]);
  return [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`)].join("\n");
}
function reportMarkdown(r) {
  const out = [];
  out.push(`# test-checker report ${r.run}`, "");
  out.push(`- Mode: ${r.mode}`);
  for (const [l, v] of Object.entries(r.revisions)) out.push(`- ${l}: ${v.given} \u2192 \`${v.commit.slice(0, 10)}\``);
  out.push(`- Date: ${r.date}`, `- Harness: ${r.harness}`, `- Blind isolation: ${r.blind_isolation}`, "");
  out.push("## Summary", "", table(r.summary), "");
  out.push("## Likely bugs", "");
  out.push(
    r.likely_bugs.length ? r.likely_bugs.map((b) => `- **${short(b.test)}** (${b.target})
  - Spec: ${b.spec_basis}
  - Failure: ${b.failure || "(none recorded)"}
  - ${b.reason}${b.suspect_existing ? `
  - suspect-existing: ${b.suspect_existing.map(short).join(", ")}` : ""}`).join("\n") : "_none_",
    ""
  );
  out.push("## Suspicions", "", r.suspicions.length ? r.suspicions.map((s) => `### ${s.target}

${s.analysis}`).join("\n\n") : "_none_", "");
  out.push("## Needs your decision", "", r.needs_decision.length ? r.needs_decision.map((d) => `- **${short(d.test)}**: ${d.question}
  - Spec: ${d.spec_basis}`).join("\n") : "_none_", "");
  out.push("## Misguided tests and what happened to them", "", r.misguided.length ? r.misguided.map((m) => `- ${short(m.test)} (${m.category}): ${m.outcome}`).join("\n") : "_none_", "");
  out.push("## Dropped", "", r.dropped.length ? r.dropped.map((d) => `- ${d.what} (${d.target}): ${d.reason}`).join("\n") : "_none_", "");
  out.push("## Promotable tests", "");
  out.push(r.promotable.length ? r.promotable.map((p) => `- ${p.file} \u2192 \`${p.dest}\` (${p.tests} test(s))`).join("\n") : "_none_");
  if (r.not_promotable.length) out.push("", "Not promotable:", ...r.not_promotable.map((s) => `- ${s.file}: ${s.reason}`));
  return out.join("\n") + "\n";
}
function consoleSummary(r, mdPath) {
  const lines = r.summary.map((s) => `${s.target}: ${Object.entries(s).filter(([k]) => k !== "target").map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const out = [
    ...lines.slice(0, 5),
    ...lines.length > 5 ? [`\u2026 ${lines.length - 5} more target(s)`] : [],
    `likely bugs: ${r.likely_bugs.length}; needs your decision: ${r.needs_decision.length}; dropped: ${r.dropped.length}`,
    `promotable files: ${r.promotable.length}`,
    `report: ${mdPath}`
  ];
  return out.slice(0, 10).join("\n");
}
function report(repo, runId, opts = {}) {
  const r = buildReport(repo, runId, opts);
  const md = repo.p("reports", `${runId}.md`);
  writeText(md, reportMarkdown(r));
  writeJson(repo.p("reports", `${runId}.json`), r);
  const run2 = loadRun(repo, runId);
  run2.status = "reported";
  saveRun(repo, run2);
  repo.ledger("run_reported", { run: runId, likely_bugs: r.likely_bugs.length, needs_decision: r.needs_decision.length });
  return { report: r, path: repo.rel(md), summary: consoleSummary(r, repo.rel(md)) };
}
var short;
var init_report = __esm({
  "src/report.ts"() {
    "use strict";
    init_classify();
    init_exec();
    init_env();
    init_run();
    init_promote();
    init_verdicts();
    init_util();
    short = (id) => id.split("::").slice(1).join("::") || id;
  }
});

// src/doctor.ts
var doctor_exports = {};
__export(doctor_exports, {
  doctor: () => doctor
});
import * as fs21 from "node:fs";
import * as path17 from "node:path";
async function doctor(repo, opts) {
  const checks = [];
  const log = opts.log ?? ((s) => process.stderr.write(s + "\n"));
  let cfg;
  try {
    cfg = repo.config;
    checks.push({ name: "config", ok: true, detail: `valid against config.schema.json` });
  } catch (e) {
    checks.push({ name: "config", ok: false, detail: e.message, fix: "Fix the fields listed above; see references/config-reference.md." });
    return { ok: false, checks, code: EXIT.REJECTED };
  }
  const src = repo.git(["ls-files", "-z"], { allowFail: true }).split("\0").find((f) => f && matchGlobs(f, cfg.source_globs));
  if (!src) checks.push({ name: "source_globs", ok: false, detail: `no tracked file matches ${JSON.stringify(cfg.source_globs)}`, fix: "Point source_globs at the project's source files." });
  else checks.push({ name: "source_globs", ok: true, detail: `e.g. ${src}` });
  const stand = { id: "tcheck-doctor", file: src ?? "doctor", symbol: "doctor" };
  const testDir = expandPath(cfg.test_dir, stand);
  const name = (n) => path17.posix.join(testDir, expandPath(cfg.test_file_pattern, stand, n));
  let files;
  if (opts.use?.length) {
    files = opts.use.map((p) => {
      const abs = path17.resolve(p);
      if (!fs21.existsSync(abs)) throw new TcheckError(`--use file not found: ${p}`, EXIT.USAGE);
      return { path: path17.posix.join(testDir, path17.basename(abs)), content: fs21.readFileSync(abs, "utf8") };
    });
  } else {
    const tpl = TEMPLATES.find((t) => t.match.test(cfg.framework));
    if (!tpl) {
      const a = name(1);
      const b = name(2);
      throw new TcheckError(
        `doctor has no template for framework "${cfg.framework}". Write two trivial ${cfg.language} tests, one that passes and one that fails, for example at ${a} and ${b}, then run: tcheck doctor --use ${a} ${b}`,
        EXIT.USAGE
      );
    }
    const pkgDir = src ? path17.posix.dirname(src) : ".";
    const goPkg = src && fs21.existsSync(path17.join(repo.root, src)) ? /^package\s+(\w+)/m.exec(fs21.readFileSync(path17.join(repo.root, src), "utf8"))?.[1] : void 0;
    files = tpl.files({ name, pkg: goPkg ?? path17.posix.basename(pkgDir), javaPkg: packagePath(stand.file).replace(/\//g, ".") }).map((f) => ({ path: name(f.n), content: f.content }));
  }
  const snapId = `doctor-${randHex(6)}`;
  const commit = snapshotWorktree(repo, snapId);
  const wt = ensureWorktree(repo, commit);
  try {
    for (const f of files) {
      const dst = path17.join(wt.dir, f.path);
      fs21.mkdirSync(path17.dirname(dst), { recursive: true });
      fs21.writeFileSync(dst, f.content);
      wt.meta.composed.push(f.path);
    }
    wt.saveMeta();
    checks.push({ name: "test files", ok: true, detail: files.map((f) => f.path).join(", ") });
    const env = commandEnv(cfg);
    const timeout = cfg.timeouts.per_command_seconds;
    const junitDir = repo.p("runs", "_doctor");
    fs21.rmSync(junitDir, { recursive: true, force: true });
    fs21.mkdirSync(junitDir, { recursive: true });
    const junit = path17.join(junitDir, "junit.xml");
    const vars = { files: files.map((f) => f.path).join(" "), junit, test_dir: testDir, root: wt.dir };
    for (const step of ["setup", "compile"]) {
      const cmd = cfg.commands[step];
      if (!cmd) continue;
      log(`doctor: ${step}: ${cmd}`);
      const r2 = await shell(fillCommand(cmd, vars), { cwd: wt.dir, env, timeoutSec: timeout });
      const ok2 = r2.code === 0;
      checks.push({ name: `commands.${step}`, ok: ok2, detail: ok2 ? "ok" : `exit ${r2.code}
${(r2.stdout + r2.stderr).slice(-1500)}`, fix: ok2 ? void 0 : hint(r2.code, cfg.framework, step) });
      if (!ok2) return { ok: false, checks, code: EXIT.COMMAND };
      if (step === "setup") {
        wt.meta.setup_done = true;
        wt.saveMeta();
      }
    }
    log(`doctor: run: ${cfg.commands.run}`);
    const r = await shell(fillCommand(cfg.commands.run, vars), { cwd: wt.dir, env, timeoutSec: timeout });
    const cases = readJUnitPath(junitDir);
    const output = (r.stdout + r.stderr).slice(-1500);
    checks.push({ name: "commands.run", ok: r.code !== 127 && !r.timedOut, detail: `exit ${r.code}${r.timedOut ? " (timeout)" : ""}`, fix: r.code === 127 ? hint(127, cfg.framework, "run") : void 0 });
    if (!cases.length) {
      checks.push({
        name: "junit",
        ok: false,
        detail: `no JUnit XML test cases at {junit}.
${output}`,
        fix: `commands.run must write JUnit XML to {junit} (a file, or a directory of XML files) and run only {files}. ${hint(r.code, cfg.framework, "run")}`
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
      fix: ok ? void 0 : pass === 0 ? `Nothing passed: the tests may not import or run. Output:
${output}` : "The failing test did not fail: check that {files} is honoured and test ids are unique."
    });
    return { ok, checks, code: ok ? EXIT.OK : EXIT.COMMAND };
  } finally {
    for (const f of wt.meta.composed) fs21.rmSync(path17.join(wt.dir, f), { force: true });
    repo.git(["worktree", "remove", "--force", wt.dir], { allowFail: true });
    fs21.rmSync(repo.p("worktrees", "_cache", `${commit}.json`), { force: true });
    repo.git(["update-ref", "-d", `refs/tcheck/${snapId}/worktree`], { allowFail: true });
  }
}
function hint(code, framework, step) {
  if (code === 127) return `A command in commands.${step} was not found on PATH. Install it or use the full path.`;
  if (/nextest/i.test(framework)) return 'cargo-nextest needs a JUnit profile: add `[profile.tcheck.junit]\\npath = "junit.xml"` to .config/nextest.toml.';
  if (/jest/i.test(framework) && !/vitest/i.test(framework)) return "jest needs the jest-junit reporter (ask the user before installing it).";
  if (/go/i.test(framework)) return "go test needs gotestsum (or go-junit-report) for JUnit output.";
  return "Run the command by hand in the repo to see what it does.";
}
var cls, TEMPLATES;
var init_doctor = __esm({
  "src/doctor.ts"() {
    "use strict";
    init_exec();
    init_junit();
    init_run();
    init_util();
    cls = (file) => path17.basename(file).replace(/\..*$/, "");
    TEMPLATES = [
      { match: /pytest/i, files: () => [{ n: 1, content: "def test_tcheck_doctor_pass():\n    assert 1 + 1 == 2\n\n\ndef test_tcheck_doctor_fail():\n    assert 1 + 1 == 3\n" }] },
      {
        match: /unittest/i,
        files: () => [{ n: 1, content: "import unittest\n\n\nclass TCheckDoctor(unittest.TestCase):\n    def test_pass(self):\n        self.assertEqual(1 + 1, 2)\n\n    def test_fail(self):\n        self.assertEqual(1 + 1, 3)\n" }]
      },
      { match: /vitest/i, files: () => [{ n: 1, content: "import { test, expect } from 'vitest';\n\ntest('tcheck doctor pass', () => { expect(1 + 1).toBe(2); });\ntest('tcheck doctor fail', () => { expect(1 + 1).toBe(3); });\n" }] },
      { match: /jest/i, files: () => [{ n: 1, content: "test('tcheck doctor pass', () => { expect(1 + 1).toBe(2); });\ntest('tcheck doctor fail', () => { expect(1 + 1).toBe(3); });\n" }] },
      {
        match: /\bgo\b|go test|gotestsum/i,
        files: ({ pkg }) => [{ n: 1, content: `package ${pkg}

import "testing"

func TestTCheckDoctorPass(t *testing.T) {}

func TestTCheckDoctorFail(t *testing.T) { t.Fatal("intentional failure") }
` }]
      },
      {
        match: /junit\s*5|jupiter/i,
        files: ({ name, javaPkg }) => [
          {
            n: 1,
            content: `${javaPkg ? `package ${javaPkg};

` : ""}import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ${cls(name(1))} {
  @Test void pass() { assertEquals(2, 1 + 1); }
  @Test void fail() { assertEquals(3, 1 + 1); }
}
`
          }
        ]
      },
      {
        match: /junit/i,
        files: ({ name, javaPkg }) => [
          {
            n: 1,
            content: `${javaPkg ? `package ${javaPkg};

` : ""}import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class ${cls(name(1))} {
  @Test public void pass() { assertEquals(2, 1 + 1); }
  @Test public void fail() { assertEquals(3, 1 + 1); }
}
`
          }
        ]
      },
      { match: /cargo|nextest|rust/i, files: () => [{ n: 1, content: "#[test]\nfn tcheck_doctor_pass() { assert_eq!(2, 1 + 1); }\n\n#[test]\nfn tcheck_doctor_fail() { assert_eq!(3, 1 + 1); }\n" }] },
      {
        match: /xunit|dotnet/i,
        files: ({ name }) => [{ n: 1, content: `using Xunit;

public class ${cls(name(1))}
{
    [Fact] public void Pass() { Assert.Equal(2, 1 + 1); }
    [Fact] public void Fail() { Assert.Equal(3, 1 + 1); }
}
` }]
      }
    ];
  }
});

// src/selftest.ts
var selftest_exports = {};
__export(selftest_exports, {
  selftest: () => selftest
});
import * as fs22 from "node:fs";
import * as path18 from "node:path";
function counts(cls2) {
  const c = ZERO();
  for (const t of cls2.tests) if (t.category in c) c[t.category]++;
  return c;
}
async function blindPipeline(repo, fx, backend, log, res, withIntent = false) {
  const run2 = runStart(repo, { mode: "bugfix", buggy: fx.buggy, fixed: fx.fixed }).id;
  const t = targetAdd(repo, run2, fx.fixture.target, fx.fixture.lines.join("-"));
  contextSet(repo, run2, t.id, path18.join(fx.fixture.dir, "context.json"));
  const opts = backendOpts(repo);
  for (let attempt = 1; ; attempt++) {
    const p = specPrompt(repo, run2, t.id, withIntent ? fx.fixture.intent : void 0);
    log(`${fx.fixture.name}: spec (attempt ${attempt})`);
    const out = await runBackend(backend, p.full, opts);
    try {
      specSave(repo, run2, t.id, out);
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      log(`${fx.fixture.name}: spec rejected (${e.message.split("\n")[0]}), retrying`);
    }
  }
  const { bundle } = bundleBuild(repo, run2, t.id);
  log(`${fx.fixture.name}: blind writer`);
  await blindRun(repo, bundle, "writer", { run: run2, backend });
  compose(repo, run2);
  let ex = await execRun(repo, run2, { log: () => {
  } });
  while (ex.targets[t.id]?.status === "needs_repair" && res.repair_rounds < repo.config.refine_rounds) {
    res.repair_rounds++;
    log(`${fx.fixture.name}: repair round ${res.repair_rounds}`);
    await blindRun(repo, bundle, "repair", { run: run2, backend });
    compose(repo, run2);
    ex = await execRun(repo, run2, { log: () => {
    } });
  }
  if (ex.targets[t.id]?.status === "failed_setup") throw new TcheckError(`setup failed: ${ex.setup_error}`, EXIT.COMMAND);
  return { run: run2, cls: classify(repo, run2) };
}
async function baselinePipeline(repo, fx, backend, log) {
  const run2 = runStart(repo, { mode: "bugfix", buggy: fx.buggy, fixed: fx.fixed }).id;
  const t = targetAdd(repo, run2, fx.fixture.target, fx.fixture.lines.join("-"));
  contextSet(repo, run2, t.id, path18.join(fx.fixture.dir, "context.json"));
  const tt = loadTarget(repo, run2, t.id);
  const ctx = JSON.parse(fs22.readFileSync(path18.join(fx.fixture.dir, "context.json"), "utf8"));
  const body = renderPrompt("code-aware-baseline.md", { ...configVars(repo, tt), target: { symbol: tt.symbol, file: tt.file, body: tt.body }, context_markdown: contextMarkdown(ctx, repo.config.language_tag) }, "baseline");
  const p = storePayload(repo, { role: "baseline", run: run2, target: t.id }, body);
  log(`${fx.fixture.name}: baseline writer`);
  ingest(repo, p.id, await runBackend(backend, p.full, backendOpts(repo)));
  compose(repo, run2);
  await execRun(repo, run2, { log: () => {
  } });
  return { run: run2, cls: classify(repo, run2) };
}
function leakClean(repo, blindRunId) {
  const { targets, opts } = leakContext(repo, blindRunId);
  const idx = payloadIndex(repo);
  const files = [
    ...listFilesRecursive(repo.p("bundles")).filter((f) => f.includes(`-${blindRunId.slice(-4)}-`)),
    ...Object.values(idx).filter((e) => e.run === blindRunId && (e.role === "writer" || e.role === "repair")).map((e) => repo.p("payloads", `${e.id}.md`))
  ];
  return files.every((f) => checkLeak(fs22.readFileSync(f, "utf8"), targets, { ...opts, threshold: 1 }).findings.length === 0);
}
async function selftest(opts) {
  const log = opts.log ?? ((s) => process.stderr.write(s + "\n"));
  const backend = opts.backend ?? firstHeadless();
  if (!backend) throw envMissing("selftest needs a headless backend: install claude, codex, opencode or pi, or pass --backend api");
  const names = opts.fixtures?.length ? opts.fixtures : listFixtures();
  if (!names.length) throw envMissing("no fixtures found");
  log(`selftest: ${names.length} fixture(s) via ${backend}${opts.withIntent ? " (with fixture intent)" : " (paper setting: no stated intent)"}`);
  const results = await Promise.all(
    names.map(async (name) => {
      const fx = buildFixtureRepo(name);
      const repo = new Repo(fx.dir);
      const res = { fixture: name, blind: null, baseline: null, errors: [], repair_rounds: 0, min_effective: fx.fixture.expect?.min_effective_blind ?? 1, leak_clean: true, dir: fx.dir };
      const settle = (p) => p.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));
      const b = await settle(blindPipeline(repo, fx, backend, log, res, opts.withIntent));
      const base = await settle(baselinePipeline(repo, fx, backend, log));
      if (b.status === "fulfilled") {
        res.blind = counts(b.value.cls);
        res.leak_clean = leakClean(repo, b.value.run);
      } else res.errors.push(`blind: ${b.reason?.message ?? b.reason}`);
      if (base.status === "fulfilled") res.baseline = counts(base.value.cls);
      else res.errors.push(`baseline: ${base.reason?.message ?? base.reason}`);
      log(`${name}: done${res.errors.length ? ` with errors: ${res.errors.join("; ")}` : ""}`);
      return res;
    })
  );
  const perFixture = results.map((r) => ({
    fixture: r.fixture,
    c1_pipeline: !!r.blind && !r.errors.some((e) => e.startsWith("blind")),
    c2_effective: (r.blind?.effective ?? 0) >= r.min_effective
  }));
  const sum = (k, side) => results.reduce((n, r) => n + (r[side]?.[k] ?? 0), 0);
  const c3 = sum("misguided", "blind") < sum("misguided", "baseline");
  const c4 = results.every((r) => r.leak_clean);
  const hardPass = perFixture.every((p) => p.c1_pipeline && p.c2_effective) && c4;
  const row = (r, side) => {
    const c = r[side];
    return `${r.fixture.padEnd(15)} ${side.padEnd(9)} ${c ? [c.effective, c.misguided, c.broken, c.neutral].map((n) => String(n).padStart(9)).join("") : "    (failed)"}`;
  };
  const table2 = [
    `${"fixture".padEnd(15)} ${"side".padEnd(9)}${["effective", "misguided", "broken", "neutral"].map((h) => h.padStart(10)).join("")}`,
    ...results.flatMap((r) => [row(r, "blind"), row(r, "baseline")]),
    `${"TOTAL".padEnd(15)} ${"blind".padEnd(9)}${["effective", "misguided", "broken", "neutral"].map((k) => String(sum(k, "blind")).padStart(10)).join("")}`,
    `${"TOTAL".padEnd(15)} ${"baseline".padEnd(9)}${["effective", "misguided", "broken", "neutral"].map((k) => String(sum(k, "baseline")).padStart(10)).join("")}`,
    "",
    ...perFixture.map((p) => `${p.fixture}: 1 pipeline ${p.c1_pipeline ? "PASS" : "FAIL"}, 2 effective \u2265 min ${p.c2_effective ? "PASS" : "FAIL"}`),
    `3 blind misguided < baseline misguided: ${c3 ? "PASS" : "WARN"} (${sum("misguided", "blind")} vs ${sum("misguided", "baseline")})`,
    `4 no body lines in bundles/payloads: ${c4 ? "PASS" : "FAIL"}`,
    ...results.filter((r) => r.errors.length).map((r) => `errors in ${r.fixture}: ${r.errors.join("; ")}`),
    `selftest: ${hardPass ? "PASS" : "FAIL"}${hardPass && !c3 ? " (criterion 3 warns)" : ""}`
  ].join("\n");
  return { backend, results, criteria: { per_fixture: perFixture, c3_fewer_misguided: c3, c4_no_leaks: c4 }, pass: hardPass, table: table2, code: hardPass ? EXIT.OK : EXIT.REJECTED };
}
var ZERO;
var init_selftest = __esm({
  "src/selftest.ts"() {
    "use strict";
    init_repo();
    init_env();
    init_fixtures();
    init_run();
    init_exec();
    init_classify();
    init_spec();
    init_bundle();
    init_backends();
    init_payload();
    init_leak();
    init_util();
    ZERO = () => ({ effective: 0, misguided: 0, broken: 0, neutral: 0 });
  }
});

// src/commands.ts
var commands_exports = {};
function need(a, i, name) {
  const v = a._[i];
  if (!v) throw usage(`missing <${name}>`);
  return v;
}
var repoOf;
var init_commands = __esm({
  "src/commands.ts"() {
    "use strict";
    init_cli();
    init_repo();
    init_run();
    init_exec();
    init_classify();
    init_util();
    init_spec();
    init_bundle();
    init_adjudicate();
    init_report();
    init_promote();
    init_hooks();
    init_mcp();
    repoOf = (a) => Repo.open({ root: str(a, "root") });
    register("doctor", async (a) => {
      const repo = Repo.open({ root: str(a, "root") });
      const r = await (await Promise.resolve().then(() => (init_doctor(), doctor_exports))).doctor(repo, { use: list(a, "use"), log: bool(a, "json") || bool(a, "quiet") ? () => {
      } : void 0 });
      const human = [
        ...r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}${c.fix ? `
     fix: ${c.fix}` : ""}`),
        r.ok ? "doctor: all checks passed." : "doctor: fix the failing checks and run again."
      ].join("\n");
      return { data: r, human, code: r.code };
    });
    register("hook", async (a) => {
      try {
        await runHookCli(a._[1] ?? "", str(a, "harness"), str(a, "root"));
      } catch (e) {
        process.stderr.write(`tcheck hook: ${e?.message ?? e}
`);
      }
      return { data: void 0, code: 0 };
    });
    register("blind-run", async (a) => {
      const { blindRun: blindRun2 } = await Promise.resolve().then(() => (init_backends(), backends_exports));
      const r = await blindRun2(repoOf(a), need(a, 1, "bundle"), str(a, "role") ?? "", { run: str(a, "run"), backend: str(a, "backend"), harness: str(a, "harness") });
      return { data: r, human: `${r.message} (backend: ${r.backend}, isolation: ${r.isolation})` };
    });
    register("selftest", async (a) => {
      const { selftest: selftest2 } = await Promise.resolve().then(() => (init_selftest(), selftest_exports));
      const r = await selftest2({ backend: str(a, "backend"), fixtures: list(a, "fixtures"), withIntent: bool(a, "with-intent"), log: bool(a, "quiet") ? () => {
      } : void 0 });
      return { data: r, human: r.table, code: r.code };
    });
    register("mcp", async () => {
      await serve();
      return { data: void 0 };
    });
    register("run start", (a) => {
      const r = runStart(repoOf(a), { mode: str(a, "mode") ?? "", buggy: str(a, "buggy"), fixed: str(a, "fixed"), existing: list(a, "existing") });
      return { data: { run: r.id, mode: r.mode, revisions: r.revisions }, human: r.id };
    });
    register("target add", (a) => {
      const t = targetAdd(repoOf(a), need(a, 1, "run"), need(a, 2, "file::symbol"), str(a, "lines") ?? "", str(a, "rev"));
      return { data: { target: t.id, file: t.file, symbol: t.symbol, lines: t.lines, rev: t.rev, body_sha: t.body_sha }, human: t.id };
    });
    register("context set", (a) => {
      const r = contextSet(repoOf(a), need(a, 1, "run"), need(a, 2, "target"), str(a, "file") ?? need(a, 3, "--file"));
      return { data: r, human: `Context saved for ${r.target}. Leak check: passed.` };
    });
    register("spec prompt", (a) => {
      const p = specPrompt(repoOf(a), need(a, 1, "run"), need(a, 2, "target"), str(a, "intent"));
      return { data: { payload: p.id, text: p.full }, human: p.full };
    });
    register("spec save", (a) => {
      const from = str(a, "from");
      if (!from) throw usage("spec save needs --from FILE (or - for stdin)");
      const r = specSave(repoOf(a), need(a, 1, "run"), need(a, 2, "target"), readInput(from));
      return { data: r, human: `Spec saved for ${r.target}. Leak check: passed.` };
    });
    register("spec show", (a) => {
      const r = specShow(repoOf(a), need(a, 1, "run"), need(a, 2, "target"));
      return { data: r, human: r.spec + (r.analysis ? `

--- spec-extractor suspicions ---
${r.analysis}` : "") };
    });
    register("spec edit", (a) => {
      const from = str(a, "from");
      if (!from) throw usage("spec edit needs --from FILE (or - for stdin)");
      const r = specEdit(repoOf(a), need(a, 1, "run"), need(a, 2, "target"), readInput(from));
      return { data: r, human: `Spec updated for ${r.target}. ${r.note}` };
    });
    register("bundle build", (a) => {
      const r = bundleBuild(repoOf(a), need(a, 1, "run"), need(a, 2, "target"));
      return { data: r, human: r.bundle };
    });
    register("bundle emit", (a) => {
      const via = str(a, "via");
      if (via && via !== "tool" && via !== "text") throw usage("--via must be tool or text");
      const r = bundleEmit(repoOf(a), need(a, 1, "bundle"), str(a, "role") ?? "", { run: str(a, "run"), via });
      return { data: { payload: r.payload, target: r.target, round: r.round, text: r.full }, human: r.full };
    });
    register("ingest", (a) => {
      const from = str(a, "from");
      if (!from) throw usage("ingest needs --from FILE (or - for stdin)");
      const r = ingest(repoOf(a), need(a, 1, "payload"), readInput(from));
      return { data: r, human: r.message };
    });
    register("compose", (a) => {
      const r = compose(repoOf(a), need(a, 1, "run"));
      const human = [`Composed ${r.files.length} file(s):`, ...r.files.map((f) => `  ${f.path}  (${f.target}, round ${f.round})`), ...r.missing.length ? [`No tests yet for: ${r.missing.join(", ")}`] : []].join("\n");
      return { data: r, human };
    });
    register("exec", async (a) => {
      const r = await execRun(repoOf(a), need(a, 1, "run"), { log: bool(a, "quiet") || bool(a, "json") ? () => {
      } : void 0 });
      const human = Object.entries(r.targets).map(([t, s]) => `${t}: ${s.status}${s.count ? ` (${s.count})` : ""}`).concat(r.setup_error ? [`setup failed:
${r.setup_error}`] : []).join("\n");
      return { data: r, human, code: r.code };
    });
    register("adjudicate queue", (a) => {
      const q2 = queue(repoOf(a), need(a, 1, "run"));
      return { data: q2, human: q2.length ? q2.map((x) => `${x.status === "pending" ? "pending " : `${x.verdict}`.padEnd(8)} ${x.test}
         ${x.category}: ${x.reason}`).join("\n") : "Nothing queued." };
    });
    register("adjudicate prompt", (a) => {
      const p = adjudicatePrompt(repoOf(a), need(a, 1, "run"), need(a, 2, "test"));
      return { data: { payload: p.id, text: p.full }, human: p.full };
    });
    register("adjudicate save", (a) => {
      const from = str(a, "from");
      if (!from) throw usage("adjudicate save needs --from FILE (or - for stdin)");
      const r = adjudicateSave(repoOf(a), need(a, 1, "run"), need(a, 2, "test"), readInput(from));
      return { data: r, human: r.message };
    });
    register("adjudicate override", (a) => {
      const r = adjudicateOverride(repoOf(a), need(a, 1, "run"), need(a, 2, "test"), str(a, "verdict") ?? "", str(a, "reason") ?? "");
      return { data: r, human: r.message };
    });
    register("report", (a) => {
      const r = report(repoOf(a), need(a, 1, "run"), { harness: str(a, "harness") });
      return { data: r.report, human: r.summary };
    });
    register("promote", (a) => {
      const r = promote(repoOf(a), need(a, 1, "run"), { tests: list(a, "tests"), allAccepted: bool(a, "all-accepted"), force: bool(a, "force") });
      const human = [
        r.promoted.length ? `Promoted ${r.promoted.length} file(s):` : "Nothing promoted.",
        ...r.promoted.map((f) => `  ${f.dest}`),
        ...r.skipped.map((s) => `  skipped ${s.file}: ${s.reason}`),
        ...r.verified.length ? [`Marked verified: ${r.verified.join(", ")}`] : []
      ].join("\n");
      return { data: r, human };
    });
    register("classify", (a) => {
      const c = classify(repoOf(a), need(a, 1, "run"));
      const human = [
        ...Object.entries(c.counts).map(([t, cs]) => `${t}: ${Object.entries(cs).map(([k, v]) => `${k} ${v}`).join(", ")}`),
        `${c.queue.length} test(s) queued for adjudication.`
      ].join("\n");
      return { data: c, human };
    });
  }
});

// src/cli.ts
import * as fs23 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
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
function register(name, h) {
  COMMANDS[name] = h;
}
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
    return fs23.realpathSync(process.argv[1]) === fs23.realpathSync(fileURLToPath2(import.meta.url));
  } catch {
    return false;
  }
}
var MULTI, BOOL, str, list, bool, repoOf2, COMMANDS, HELP;
var init_cli = __esm({
  "src/cli.ts"() {
    init_util();
    init_repo();
    init_env();
    init_init();
    init_dirty();
    init_lib();
    MULTI = /* @__PURE__ */ new Set(["existing", "tests", "fixtures", "use"]);
    BOOL = /* @__PURE__ */ new Set(["json", "quiet", "force", "keep", "all-accepted", "include-neutral", "help", "with-intent"]);
    str = (a, k) => typeof a.flags[k] === "string" ? a.flags[k] : void 0;
    list = (a, k) => Array.isArray(a.flags[k]) ? a.flags[k] : typeof a.flags[k] === "string" ? [a.flags[k]] : [];
    bool = (a, k) => a.flags[k] === true;
    repoOf2 = (a, requireConfig = true) => Repo.open({ root: str(a, "root"), requireConfig });
    COMMANDS = {
      env: (a) => {
        const r = envReport({ root: str(a, "root"), harness: str(a, "harness") });
        return { data: r, human: Object.entries(r).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") || "-" : v ?? "-"}`).join("\n") };
      },
      init: (a) => {
        const r = init(repoOf2(a, false), { language: str(a, "language"), framework: str(a, "framework"), force: bool(a, "force") });
        return { data: r, human: [`Wrote ${r.config} from examples/${r.example}.`, ...r.warnings.map((w) => `warning: ${w}`), "Next: edit it, then run `tcheck doctor`."].join("\n") };
      },
      status: async (a) => (await Promise.resolve().then(() => (init_status(), status_exports))).status(repoOf2(a)),
      scope: (a) => {
        const r = scope(repoOf2(a), str(a, "since"));
        return { data: r, human: r.length ? r.map((e) => `${e.file} ${e.ranges.map(([x, y]) => `${x}-${y}`).join(",")}${e.verified ? " (verified)" : ""}`).join("\n") : "No changed source files." };
      },
      waive: (a) => {
        const files = waive(repoOf2(a), a._.slice(1), str(a, "reason") ?? "");
        return { data: { waived: files }, human: `Waived ${files.length} file(s).` };
      }
    };
    HELP = `tcheck \u2014 test-checker engine

Usage: tcheck <command> [args] [--json] [--root DIR] [--harness NAME] [--quiet]

Setup:      env | init | doctor | status | scope | waive
Run:        run start | target add | context set | spec prompt|save|show|edit
            bundle build|emit | blind-run | ingest | compose | exec | classify
            adjudicate queue|prompt|save|override | report | promote
Integrate:  hook <event> | mcp | selftest

See docs/engine-spec.md \xA75.`;
    if (isMain()) {
      main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
      });
    }
  }
});
init_cli();
export {
  TOOLS as MCP_TOOLS,
  Repo,
  adjudicatePrompt,
  adjudicateSave,
  bool,
  buildFixtureRepo,
  bundleEmit,
  callTool,
  checkLeak,
  childEnv,
  detectHarness,
  dirtyFiles,
  editedPaths,
  evaluateHook,
  findRoot,
  frame,
  globToRegex,
  handle as handleMcp,
  hookOutput,
  ingest,
  list,
  listFixtures,
  loadFixture,
  loadPayload,
  main,
  mapRange,
  matchGlobs,
  normalize,
  normalize2 as normalizeHookEvent,
  parseArgs,
  parseConfig,
  parseFrame,
  parseJUnit,
  parseSpecOutput,
  parseTextSubmission,
  parseVerdict,
  parseYaml,
  payloadIndex,
  pluginRoot,
  protectGlobs,
  redactLeaks,
  redactRepairText,
  register,
  renderTemplate,
  resolveBackend,
  runBackend,
  signatureLineCount,
  significantLines,
  specPrompt,
  specSave,
  str,
  submitTests,
  validate
};
