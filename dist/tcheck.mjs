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
  return new Promise((resolve2) => {
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
      resolve2({ code: 127, stdout, stderr: stderr + String(e.message) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve2({ code: code ?? 1, stdout, stderr, timedOut });
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

// src/env.ts
import * as fs4 from "node:fs";
import * as path4 from "node:path";
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
    const [, , close, tag, attrText, selfClose] = m;
    if (!tag) continue;
    if (!close && tag === "testcase") {
      const a = attrs(attrText);
      cur = { classname: a.classname ?? "", name: a.name ?? "", outcome: "pass", ...a.file ? { file: a.file } : {} };
      if (selfClose) {
        cases.push(cur);
        cur = null;
      }
    } else if (close && tag === "testcase" && cur) {
      cases.push(cur);
      cur = null;
    } else if (cur && !close && (tag === "failure" || tag === "error" || tag === "skipped")) {
      const a = attrs(attrText);
      if (cur.outcome === "pass" || tag !== "skipped") cur.outcome = tag;
      if (a.type) cur.type = a.type;
      if (a.message) cur.message = a.message;
      if (!selfClose) {
        child = tag;
        buf = "";
      }
    } else if (close && child && tag === child && cur) {
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
function normalize(line) {
  return line.trim().replace(/\s+/g, " ").replace(/[;,]+$/, "");
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
    const bodyShingles = shingles(tokens(t.body_lines.join("\n")));
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

// src/run.ts
import * as fs8 from "node:fs";
import * as os2 from "node:os";
import * as path7 from "node:path";
function runDir(repo, runId, ...p) {
  return repo.p("runs", runId, ...p);
}
function loadRun(repo, runId) {
  const f = runDir(repo, runId, "run.json");
  if (!fs8.existsSync(f)) throw usage(`unknown run: ${runId}`);
  return readJson(f);
}
function saveRun(repo, run2) {
  writeJson(runDir(repo, run2.id, "run.json"), run2);
}
function newRunId() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `r-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randHex(4)}`;
}
function snapshotWorktree(repo, runId) {
  const head = repo.commit("HEAD");
  const idx = path7.join(os2.tmpdir(), `tcheck-index-${randHex(8)}`);
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
    fs8.rmSync(idx, { force: true });
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
  const resolve2 = (label, rev) => {
    given[label] = rev;
    revisions[label] = rev === "WORKTREE" ? snapshotWorktree(repo, id) : repo.commit(rev);
  };
  if (mode === "bugfix") {
    resolve2("buggy", opts.buggy ?? "HEAD");
    resolve2("fixed", opts.fixed ?? "WORKTREE");
  } else {
    if (opts.buggy || opts.fixed) throw usage(`--buggy/--fixed only apply to bugfix mode`);
    resolve2("current", "WORKTREE");
  }
  const existing = (opts.existing ?? []).map((p) => repo.rel(p));
  if (mode === "audit" && !existing.length) throw usage("audit mode needs --existing <test paths>");
  for (const e of existing) if (!fs8.existsSync(path7.join(repo.root, e))) throw usage(`--existing path not found: ${e}`);
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
  if (!fs8.existsSync(f)) throw usage(`unknown target ${targetIdArg} in run ${runId}`);
  return readJson(f);
}
function ensureWorktree(repo, sha, key = sha) {
  const dir = repo.p("worktrees", "_cache", key);
  const metaFile = repo.p("worktrees", "_cache", `${key}.json`);
  let fresh = false;
  if (!fs8.existsSync(path7.join(dir, ".git"))) {
    fs8.rmSync(dir, { recursive: true, force: true });
    repo.git(["worktree", "prune"], { allowFail: true });
    fs8.mkdirSync(path7.dirname(dir), { recursive: true });
    repo.git(["worktree", "add", "--detach", "--force", dir, sha]);
    fs8.rmSync(metaFile, { force: true });
    fresh = true;
  }
  const meta = readJson(metaFile, { setup_done: false, composed: [] });
  for (const f of meta.composed) fs8.rmSync(path7.join(dir, f), { force: true });
  meta.composed = [];
  repo.git(["-C", dir, "checkout", "--force", "--detach", sha], { allowFail: true });
  repo.git(["-C", dir, "checkout", "--", "."], { allowFail: true });
  return { dir, meta, fresh, saveMeta: () => writeJson(metaFile, meta) };
}
function words(symbol) {
  return symbol.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
}
function packagePath(file) {
  const dir = path7.posix.dirname(file);
  const m = /(?:^|\/)(?:java|kotlin|scala|groovy)\/(.*)$/.exec(dir);
  return m ? m[1] : dir === "." ? "" : dir;
}
function expandPath(template, t, n) {
  const w = words(t.symbol);
  const vals = {
    symbol: w.map((x) => x.toLowerCase()).join("_"),
    Symbol: w.map((x) => x[0].toUpperCase() + x.slice(1)).join(""),
    target_slug: t.id.replace(/-/g, "_"),
    pkg_dir: path7.posix.dirname(t.file),
    package_path: packagePath(t.file)
  };
  if (n !== void 0) vals.n = String(n);
  return template.replace(/\{(\w+)\}/g, (m, k) => vals[k] ?? m).replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}
function generatedDir(repo, runId, targetIdArg, round) {
  const base = repo.p("generated", runId, targetIdArg);
  return round === void 0 ? base : path7.join(base, `round-${round}`);
}
function latestRound(repo, runId, targetIdArg) {
  const base = generatedDir(repo, runId, targetIdArg);
  if (!fs8.existsSync(base)) return null;
  const rounds = fs8.readdirSync(base).map((d) => /^round-(\d+)$/.exec(d)).filter(Boolean).map((m) => parseInt(m[1], 10));
  return rounds.length ? Math.max(...rounds) : null;
}
function compose(repo, runId) {
  const run2 = loadRun(repo, runId);
  const cfg = repo.config;
  const files = [];
  const missing = [];
  const outDir = runDir(repo, runId, "composed");
  fs8.rmSync(outDir, { recursive: true, force: true });
  for (const tid of run2.targets) {
    const t = loadTarget(repo, runId, tid);
    const round = latestRound(repo, runId, tid);
    if (round === null) {
      missing.push(tid);
      continue;
    }
    const dir = expandPath(cfg.test_dir, t);
    for (const src of listFilesRecursive(generatedDir(repo, runId, tid, round))) {
      const name = path7.basename(src);
      if (name === "notes.md") continue;
      const final = path7.posix.join(dir, name);
      const clash = files.find((f) => f.path === final);
      if (clash) throw rejected(`two targets produced the same test file ${final} (${clash.target}, ${tid}); use {target_slug} in test_file_pattern`);
      files.push({ path: final, target: tid, round, source: path7.relative(repo.root, src) });
      writeText(path7.join(outDir, final), fs8.readFileSync(src, "utf8"));
    }
  }
  if (!files.length) throw usage(`no submitted tests to compose in ${runId}${missing.length ? ` (waiting on: ${missing.join(", ")})` : ""}`);
  writeJson(runDir(repo, runId, "composed.json"), { at: nowIso(), files });
  return { files, missing };
}
var LABELS, ERRORS_LABEL;
var init_run = __esm({
  "src/run.ts"() {
    "use strict";
    init_util();
    init_leak();
    LABELS = { bugfix: ["buggy", "fixed"], new: ["current"], audit: ["current"] };
    ERRORS_LABEL = { bugfix: "fixed", new: "current", audit: "current" };
  }
});

// src/exec.ts
import * as fs9 from "node:fs";
import * as path8 from "node:path";
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
  return cmd.replace(/\{(files|junit|test_dir|root)\}/g, (_, k) => vars[k]);
}
function mapCase(c, files) {
  const noExt = (p) => p.replace(/\.[^/.]+$/, "");
  const stem = (p) => path8.posix.basename(p).split(".")[0];
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
  if (!fs9.existsSync(composedFile)) throw usage(`nothing composed for ${runId}; run \`tcheck compose ${runId}\` first`);
  const composed = readJson(composedFile).files;
  const n = run2.exec_count + 1;
  const env = commandEnv(cfg);
  const patterns = repairPatterns(cfg);
  const results = { exec: n, at: nowIso(), labels: {} };
  const files = [
    ...composed.map((f) => ({ path: f.path, target: f.target, content: fs9.readFileSync(path8.join(runDir(repo, runId, "composed"), f.path), "utf8") })),
    ...run2.existing.map((p) => ({ path: p, target: "existing", content: fs9.readFileSync(path8.join(repo.root, p), "utf8") }))
  ];
  const testDir = composed.length ? path8.posix.dirname(composed[0].path) : "";
  const runLabel = async (label, commit, reruns, patch, only) => {
    const wt = ensureWorktree(repo, commit, patch ? `${commit}-mutant` : commit);
    const lr = { commit, load_errors: [], timed_out: [], tests: {}, unmapped: 0 };
    const labelFiles = only ?? files;
    for (const f of composed) {
      const src = path8.join(runDir(repo, runId, "composed"), f.path);
      const dst = path8.join(wt.dir, f.path);
      fs9.mkdirSync(path8.dirname(dst), { recursive: true });
      fs9.copyFileSync(src, dst);
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
    const vars = { files: labelFiles.map((f) => q(f.path)).join(" "), test_dir: testDir, root: wt.dir, junit: "" };
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
      fs9.rmSync(kdir, { recursive: true, force: true });
      fs9.mkdirSync(kdir, { recursive: true });
      const junit = path8.join(kdir, "junit.xml");
      const cmd = fillCommand(cfg.commands.run, { ...vars, junit: q(junit) });
      log(`[${label}] run ${k}/${reruns}`);
      const r = await shell(cmd, { cwd: wt.dir, env, timeoutSec: timeout });
      fs9.writeFileSync(path8.join(kdir, "output.txt"), `$ ${cmd}
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
    }
    const ids = new Set(perRerun.flatMap((m) => [...m.keys()]));
    for (const id of ids) {
      const outcomes = perRerun.map((m, i) => m.get(id)?.c.outcome ?? (lr.timed_out.includes(i + 1) ? "error" : null));
      const present = outcomes.filter((o) => o !== null);
      const first = perRerun.map((m) => m.get(id)).find(Boolean);
      const final = new Set(present).size > 1 ? "flaky" : present[0];
      const c = first.c;
      lr.tests[id] = { id, target: first.f.target, file: first.f.path, classname: c.classname, name: c.name, outcomes, final, type: c.type, message: c.message, text: c.text ? tail(c.text) : void 0 };
      if (isRepairable({ final, type: c.type, message: c.message, text: c.text }, patterns)) lr.tests[id].repairable = true;
    }
    return lr;
  };
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
      const counts = {};
      for (const t of Object.values(r.tests)) counts[t.final] = (counts[t.final] ?? 0) + 1;
      return [l, { ...counts, load_errors: r.load_errors.length, ...r.compile_error ? { compile_error: true } : {}, ...r.setup_error ? { setup_error: true } : {} }];
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
  if (!fs9.existsSync(f)) throw usage(`no results for ${runId}; run \`tcheck exec ${runId}\``);
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
import * as fs10 from "node:fs";
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
  const queue = [];
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
      queue.push({ test: c.id, category: c.category, reason: c.category === "misguided" ? "fails on the fixed revision but passes on the buggy one" : "fails on both revisions", revision: "fixed" });
    }
    if (c.category === "disputed") queue.push({ test: c.id, category: c.category, reason: "fails on the current code", revision: "current" });
  }
  if (run2.mode === "audit") {
    const existing = tests.filter((t) => t.existing && t.category === "accepted");
    for (const qi of queue) {
      const bt = tests.find((t) => t.id === qi.test);
      const target = loadTarget(repo, runId, bt.target);
      const unit = target.symbol.split(/[.:#]/).pop();
      const re = new RegExp(`\\b${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      const pair = existing.filter((e) => re.test(fs10.readFileSync(`${repo.root}/${e.file}`, "utf8"))).map((e) => e.id);
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
  const counts = {};
  for (const t of tests) {
    const k = t.existing ? "existing" : t.target;
    counts[k] ??= {};
    counts[k][t.category] = (counts[k][t.category] ?? 0) + 1;
  }
  const out = { run: runId, exec: res.exec, mode: run2.mode, at: nowIso(), tests, queue, counts, dropped, ...kill_rate ? { kill_rate } : {} };
  writeJson(runDir(repo, runId, "classification.json"), out);
  repo.ledger("classified", { run: runId, exec: res.exec, counts, queued: queue.length });
  return out;
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
    repoOf = (a) => Repo.open({ root: str(a, "root") });
    register("run start", (a) => {
      const r = runStart(repoOf(a), { mode: str(a, "mode") ?? "", buggy: str(a, "buggy"), fixed: str(a, "fixed"), existing: list(a, "existing") });
      return { data: { run: r.id, mode: r.mode, revisions: r.revisions }, human: r.id };
    });
    register("target add", (a) => {
      const t = targetAdd(repoOf(a), need(a, 1, "run"), need(a, 2, "file::symbol"), str(a, "lines") ?? "", str(a, "rev"));
      return { data: { target: t.id, file: t.file, symbol: t.symbol, lines: t.lines, rev: t.rev, body_sha: t.body_sha }, human: t.id };
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
import * as fs11 from "node:fs";
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
    return fs11.realpathSync(process.argv[1]) === fs11.realpathSync(fileURLToPath2(import.meta.url));
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
    BOOL = /* @__PURE__ */ new Set(["json", "quiet", "force", "keep", "all-accepted", "include-neutral", "help"]);
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
  Repo,
  bool,
  buildFixtureRepo,
  checkLeak,
  detectHarness,
  dirtyFiles,
  findRoot,
  globToRegex,
  list,
  listFixtures,
  loadFixture,
  main,
  matchGlobs,
  normalize,
  parseArgs,
  parseConfig,
  parseJUnit,
  parseYaml,
  pluginRoot,
  redactLeaks,
  redactRepairText,
  register,
  resolveBackend,
  signatureLineCount,
  significantLines,
  str,
  validate
};
