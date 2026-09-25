import * as fs from "node:fs";
import * as path from "node:path";
import { Repo, enginePath, findRoot, pluginRoot } from "./repo";
import { dirtyFiles } from "./dirty";
import { run, which } from "./util";

export type Harness = "claude-code" | "cowork" | "codex" | "opencode" | "pi" | "unknown";
const HARNESSES: Harness[] = ["claude-code", "cowork", "codex", "opencode", "pi", "unknown"];

/** engine-spec §4 precedence: flag, TCHECK_HARNESS, heuristics, unknown. */
export function detectHarness(flag?: string, env: NodeJS.ProcessEnv = process.env): Harness {
  const explicit = flag ?? env.TCHECK_HARNESS;
  if (explicit && HARNESSES.includes(explicit as Harness)) return explicit as Harness;
  // Codex gives plugin hooks PLUGIN_ROOT *and* CLAUDE_PLUGIN_ROOT (compat), so CLAUDECODE is the reliable Claude signal
  // and Codex markers win over a bare CLAUDE_PLUGIN_ROOT.
  const codex = !!env.PLUGIN_ROOT || Object.keys(env).some((k) => k.startsWith("CODEX_") && k !== "CODEX_HOME");
  if (env.CLAUDECODE === "1" || (env.CLAUDE_PLUGIN_ROOT && !codex)) {
    // VERIFY: Cowork's marker. Claude Code sets CLAUDE_CODE_ENTRYPOINT (cli, sdk-ts, claude-desktop, …).
    return /cowork/i.test(env.CLAUDE_CODE_ENTRYPOINT ?? "") ? "cowork" : "claude-code";
  }
  return codex ? "codex" : "unknown";
}

export type Backend = "native" | "api" | "codex" | "claude" | "opencode" | "pi" | "none";
export const HEADLESS: Backend[] = ["claude", "codex", "opencode", "pi"];

export const ISOLATION: Record<Backend, "strong" | "medium" | "none"> = {
  native: "strong",
  api: "strong",
  opencode: "strong",
  claude: "medium",
  codex: "medium",
  pi: "medium",
  none: "none",
};

/** engine-spec §11 backend `auto`. */
export function resolveBackend(configured: string | undefined, harness: Harness, apiKeyEnv?: string): Backend {
  if (configured && configured !== "auto") return configured as Backend;
  if (harness === "claude-code" || harness === "cowork" || harness === "opencode" || harness === "pi") return "native";
  if (harness === "codex") return "codex";
  return firstHeadless() ?? (apiKeyEnv && process.env[apiKeyEnv] ? "api" : "none");
}

export function firstHeadless(): Backend | null {
  for (const b of HEADLESS) if (which(b)) return b;
  return null;
}

export function gitVersion(): string | null {
  const r = run("git", ["--version"]);
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout);
  return r.code === 0 && m ? m[1] : null;
}

export function envReport(opts: { root?: string; harness?: string }) {
  const harness = detectHarness(opts.harness);
  const warnings: string[] = [];
  const gitV = gitVersion();
  if (!gitV) warnings.push("git not found on PATH");
  else if (cmpVersion(gitV, "2.30") < 0) warnings.push(`git ${gitV} is older than 2.30`);
  if (cmpVersion(process.versions.node, "20") < 0) warnings.push(`node ${process.versions.node} is older than 20`);

  const root = findRoot({ root: opts.root });
  let config: "present" | "missing" | "invalid" = "missing";
  let gate: string | null = null;
  let dirty: number | null = null;
  let backend: Backend = resolveBackend(undefined, harness);
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
      } catch (e: any) {
        config = "invalid";
        warnings.push(e.message);
      }
      const seen = repo.state().hooks_seen_at;
      hooksSeen = !!seen && Date.now() - Date.parse(seen) < 24 * 3600 * 1000;
    }
  }
  if (backend === "none") warnings.push("no blind backend available: install claude, codex, opencode or pi, or configure blind.backend: api");
  const ref = path.join(pluginRoot(), "skills", "verify-tests", "references", "harness", `${harnessRefName(harness)}.md`);
  return {
    harness,
    engine: `node "${enginePath()}"`,
    plugin_root: pluginRoot(),
    harness_reference: fs.existsSync(ref) ? ref : path.join(path.dirname(ref), "generic.md"),
    node: process.versions.node,
    git: gitV ?? "missing",
    repo_root: root,
    config,
    blind_backend: backend,
    blind_isolation: ISOLATION[backend],
    hooks_seen: hooksSeen,
    gate,
    dirty_files: dirty,
    warnings,
  };
}

function harnessRefName(h: Harness): string {
  return h === "cowork" ? "claude-code" : h === "unknown" ? "generic" : h;
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
