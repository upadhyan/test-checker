import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Repo } from "./repo";
import { Backend, ISOLATION, detectHarness, firstHeadless, resolveBackend } from "./env";
import { bundleEmit, ingest, loadBundle } from "./bundle";
import { Role } from "./payload";
import { runDir } from "./run";
import { EXIT, TcheckError, envMissing, isWin, usage, which, writeText } from "./util";

export interface BackendOpts {
  model?: string | null;
  timeoutSec?: number;
  api?: { provider: "anthropic" | "openai"; model: string | null; key_env: string };
}

/** Session variables a nested harness CLI must not inherit (it would think it runs inside our session). */
const STRIP = /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|HOST_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SDK_HAS_HOST_AUTH_REFRESH|SESSION_ATTENDED|EMIT_TOOL_USE_SUMMARIES|REPORT_FINDINGS|TERMINAL_MCP_TOOLS)|CLAUDE_PID|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_AGENT_SDK_VERSION|PLUGIN_ROOT|TCHECK_HARNESS|CODEX_THREAD_ID|CODEX_SANDBOX.*)$/;

export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return env;
}

function spawnText(cmd: string, args: string[], opts: { cwd: string; input?: string; timeoutSec: number }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: childEnv(), windowsHide: true, shell: isWin, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/** Deny-all agent definition for the opencode backend (written into the temp dir only). */
function opencodeConfig(): string {
  const deny = Object.fromEntries(["edit", "bash", "webfetch", "websearch", "read", "glob", "grep", "list", "task", "todowrite", "todoread", "skill", "external_directory", "lsp"].map((k) => [k, "deny"]));
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", agent: { "tcheck-blind-writer": { mode: "primary", description: "test-checker blind role (no tools)", permission: deny, tools: { "*": false } } } }, null, 2);
}

/**
 * engine-spec §11: send a prompt to a headless backend and return its text reply.
 * The temp dir lives under the OS temp root, holds only PROMPT.md (plus the opencode agent file), and is removed.
 */
export async function runBackend(backend: Backend, prompt: string, opts: BackendOpts = {}): Promise<string> {
  const timeoutSec = opts.timeoutSec ?? 900;
  if (backend === "api") return apiCall(prompt, opts);
  if (!["claude", "codex", "opencode", "pi"].includes(backend)) throw usage(`backend ${backend} cannot run headless prompts`);
  if (!which(backend)) throw envMissing(`backend ${backend} is not installed (not on PATH)`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcheck-blind-")));
  try {
    fs.writeFileSync(path.join(tmp, "PROMPT.md"), prompt);
    let args: string[];
    let input: string | undefined;
    let outFile: string | undefined;
    const model = opts.model ? [opts.model] : [];
    switch (backend) {
      case "claude":
        // VERIFY 4 (claude 2.1.x): no built-in tools, no MCP servers, no settings/plugins/hooks, no skills.
        // --bare would also skip CLAUDE.md but forces API-key auth, which breaks subscription login.
        args = ["-p", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", ...(model.length ? ["--model", ...model] : [])];
        input = prompt;
        break;
      case "codex":
        outFile = path.join(tmp, "..", `${path.basename(tmp)}-last.md`);
        args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-C", tmp, "-o", outFile, ...(model.length ? ["-m", ...model] : []), "-"];
        input = prompt;
        break;
      case "opencode":
        fs.writeFileSync(path.join(tmp, "opencode.json"), opencodeConfig());
        args = ["run", "--agent", "tcheck-blind-writer", "--dir", tmp, ...(model.length ? ["-m", ...model] : []), prompt];
        break;
      default: // pi
        args = ["-p", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--offline", ...(model.length ? ["--model", ...model] : []), prompt];
    }
    const r = await spawnText(backend, args, { cwd: tmp, input, timeoutSec });
    if (r.timedOut) throw new TcheckError(`${backend} timed out after ${timeoutSec}s`, EXIT.COMMAND);
    if (r.code !== 0) throw new TcheckError(`${backend} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-800)}`, EXIT.COMMAND);
    const text = outFile && fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : r.stdout;
    if (outFile) fs.rmSync(outFile, { force: true });
    if (!text.trim()) throw new TcheckError(`${backend} returned no text${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").slice(-3).join(" | ").slice(-600)}` : ""}`, EXIT.COMMAND);
    return text;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Opt-in direct API call (no tools). Never a default: it needs a key the user chose to provide. */
async function apiCall(prompt: string, opts: BackendOpts): Promise<string> {
  const api = opts.api;
  if (!api?.model) throw usage("blind.backend: api needs blind.api.model");
  const key = process.env[api.key_env];
  if (!key) throw envMissing(`blind.backend: api needs the ${api.key_env} environment variable`);
  const res =
    api.provider === "openai"
      ? await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: api.model, input: prompt }),
        })
      : await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: api.model, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
        });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new TcheckError(`${api.provider} API ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`, EXIT.COMMAND);
  const text =
    api.provider === "openai"
      ? body.output_text ?? (body.output ?? []).flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? "").join("")
      : (body.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  if (!text?.trim()) throw new TcheckError(`${api.provider} API returned no text`, EXIT.COMMAND);
  return text;
}

export function backendOpts(repo: Repo): BackendOpts {
  const c = repo.config;
  return { model: c.blind.model, api: c.blind.api, timeoutSec: Math.max(c.timeouts.per_command_seconds, 300) };
}

/** `tcheck blind-run`: render the payload internally, run the backend, ingest. Never prints the payload. */
export async function blindRun(repo: Repo, bundle: string, role: Role, opts: { run?: string; backend?: string; harness?: string } = {}) {
  const harness = detectHarness(opts.harness);
  const backend = opts.backend ? (opts.backend as Backend) : resolveBackend(repo.config.blind.backend, harness, repo.config.blind.api.key_env);
  if (backend === "native") {
    throw new TcheckError(
      `blind-run is for harnesses without a native blind role. In ${harness}, launch the blind subagent with \`tcheck bundle emit\` (see the harness reference), or pass --backend claude|codex|opencode|pi.`,
      EXIT.USAGE,
    );
  }
  if (backend === "none") throw envMissing("no blind backend available: install claude, codex, opencode or pi (each runs on its own subscription login), or opt in to blind.backend: api");
  loadBundle(repo, bundle);
  const p = bundleEmit(repo, bundle, role, { run: opts.run, via: "text" });
  const text = await runBackend(backend, p.full, backendOpts(repo));
  writeText(path.join(runDir(repo, loadBundle(repo, bundle).meta.run_id, "blind"), `${p.payload}.out.md`), text);
  const r = ingest(repo, p.payload, text);
  return { ...r, backend, isolation: ISOLATION[backend], payload: p.payload };
}

export { firstHeadless };
