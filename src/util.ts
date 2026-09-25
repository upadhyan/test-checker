import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** Exit codes, engine-spec §5. */
export const EXIT = { OK: 0, USAGE: 1, REJECTED: 2, ENV: 3, COMMAND: 4 } as const;

export class TcheckError extends Error {
  constructor(message: string, public code: number = EXIT.USAGE, public details?: unknown) {
    super(message);
  }
}

export const usage = (m: string) => new TcheckError(m, EXIT.USAGE);
export const rejected = (m: string, details?: unknown) => new TcheckError(m, EXIT.REJECTED, details);
export const envMissing = (m: string) => new TcheckError(m, EXIT.ENV);

export const isWin = process.platform === "win32";

export function sha256(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function randHex(n: number): string {
  return crypto.randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function readJson<T = any>(file: string, fallback?: T): T {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw usage(`missing file: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Read a file argument; `-` means stdin. */
export function readInput(file: string): string {
  if (file === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(file)) throw usage(`file not found: ${file}`);
  return fs.readFileSync(file, "utf8");
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Run a program directly (no shell). Used for git. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) return { code: 127, stdout: "", stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; allowFail?: boolean } = {}): string {
  const r = run("git", args, { cwd, env: opts.env, input: opts.input });
  if (r.code !== 0 && !opts.allowFail) {
    throw new TcheckError(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`, r.code === 127 ? EXIT.ENV : EXIT.COMMAND);
  }
  return r.stdout;
}

export function gitOk(cwd: string, args: string[]): boolean {
  return run("git", args, { cwd }).code === 0;
}

/**
 * Run a shell command string (configs are shell strings, engine-spec §2),
 * killing the whole process tree on timeout.
 */
export function shell(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutSec?: number; input?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    const [sh, flag] = isWin ? ["cmd.exe", "/c"] : ["/bin/sh", "-c"];
    const child = spawn(sh, [flag, command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: !isWin,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    const timer = opts.timeoutSec
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutSec * 1000)
      : undefined;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e.message) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWin) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/** Is an executable on PATH? */
export function which(name: string): string | null {
  const r = isWin ? run("where", [name]) : run("/bin/sh", ["-c", `command -v ${name}`]);
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

/**
 * Glob → RegExp. Supports `**`, `*`, `?`, `{a,b}`. Paths are posix-style, repo-relative.
 */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches everything.
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

/** Match against a glob list where `!pattern` entries exclude. */
export function matchGlobs(file: string, globs: string[]): boolean {
  const f = toPosix(file);
  let hit = false;
  for (const g of globs) {
    if (g.startsWith("!")) {
      if (globToRegex(g.slice(1)).test(f)) return false;
    } else if (globToRegex(g).test(f)) hit = true;
  }
  return hit;
}

export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out.sort();
}

export function copyDir(src: string, dst: string): void {
  fs.cpSync(src, dst, { recursive: true });
}
