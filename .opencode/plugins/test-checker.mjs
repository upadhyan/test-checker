// OpenCode integration for test-checker (engine-spec §15). Thin: everything real lives in dist/tcheck.mjs.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Repo, findRoot, callTool, evaluateHook } from "../../dist/tcheck.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Agent name → the one plugin tool it may call. */
const AGENTS = {
  "tcheck-spec-extractor": "tcheck_save_spec",
  "tcheck-blind-writer": "tcheck_submit_tests",
  "tcheck-repair": "tcheck_submit_tests",
  "tcheck-adjudicator": "tcheck_save_verdict",
};
const BUILTIN = ["read", "edit", "write", "bash", "glob", "grep", "list", "patch", "task", "webfetch", "websearch", "todowrite", "todoread", "skill", "lsp", "codesearch"];

function agentBody(name) {
  const text = fs.readFileSync(path.join(ROOT, "agents", `${name}.md`), "utf8");
  const description = /^description:\s*(.+)$/m.exec(text)?.[1] ?? name;
  return { description, prompt: text.replace(/^---[\s\S]*?\n---\n/, "").trim() };
}

function repoAt(dir) {
  const root = findRoot({ cwd: dir, gitFallback: false });
  return root ? Repo.open({ root }) : null;
}

/** tool.schema comes from @opencode-ai/plugin (zod). We ship no deps, so resolve it from the host. VERIFY 8. */
async function zod() {
  for (const spec of ["@opencode-ai/plugin", "zod"]) {
    try {
      const m = await import(spec);
      return m.tool?.schema ?? m.z ?? m.default;
    } catch {}
  }
  return null;
}

export const TestChecker = async ({ client, directory }) => {
  const z = await zod();
  const gated = new Set(); // sessions already nudged by the stop gate (avoid loops)
  const run = (name) => async (args, context) => {
    const repo = repoAt(context?.directory ?? directory);
    if (!repo) return "ERROR: no .test-checker/config.yaml in this project";
    try {
      return callTool(name.replace(/^tcheck_/, ""), args, repo);
    } catch (e) {
      return `ERROR: ${e?.message ?? e}`;
    }
  };
  const tools = {};
  if (z) {
    const internal = "For test-checker's internal roles only; never call this yourself.";
    tools.tcheck_submit_tests = {
      description: `Submit unit test files for a test-checker payload. ${internal}`,
      args: { payload_id: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })), notes: z.string().optional() },
      execute: run("tcheck_submit_tests"),
    };
    tools.tcheck_save_spec = { description: `Save the spec-extractor answer for a test-checker payload. ${internal}`, args: { payload_id: z.string(), raw_output: z.string() }, execute: run("tcheck_save_spec") };
    tools.tcheck_save_verdict = { description: `Save the adjudicator verdict for a test-checker payload. ${internal}`, args: { payload_id: z.string(), raw_output: z.string() }, execute: run("tcheck_save_verdict") };
  } else {
    console.error("test-checker: could not load zod/@opencode-ai/plugin; blind role tools are unavailable (use `tcheck blind-run`).");
  }

  return {
    tool: tools,

    config: async (config) => {
      // VERIFY 8: the config key OpenCode reads extra skill directories from.
      config.skills = { ...(config.skills ?? {}), paths: [...(config.skills?.paths ?? []), path.join(ROOT, "skills")] };
      config.agent ??= {};
      for (const [name, allowed] of Object.entries(AGENTS)) {
        const { description, prompt } = agentBody(name);
        config.agent[name] = {
          mode: "subagent",
          hidden: true,
          description,
          prompt,
          permission: Object.fromEntries([...BUILTIN, "external_directory"].map((k) => [k, "deny"])),
          tools: { "*": false, [allowed]: true },
        };
      }
    },

    "shell.env": async (_input, output) => {
      output.env.TCHECK_HARNESS = "opencode";
    },

    "tool.execute.before": async (input, output) => {
      const event = input.tool === "task" ? "handoff-guard" : ["edit", "write", "patch", "multiedit"].includes(input.tool) ? "protect-tests" : null;
      if (!event) return;
      const d = evaluateHook({ event, tool: input.tool, input: output.args, subagent: output.args?.subagent_type, cwd: directory });
      if (d.action === "deny") throw new Error(d.reason);
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const d = evaluateHook({ event: "session-start", cwd: directory });
      if (d.action === "context") output.system.push(d.text);
    },

    // VERIFY 8: end-of-turn arrives as the `session.idle` event.
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      const sessionID = event.properties?.sessionID;
      const d = evaluateHook({ event: "stop-gate", cwd: directory, stopHookActive: gated.has(sessionID) });
      if (d.action === "block" && sessionID) {
        gated.add(sessionID);
        await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: d.reason }] } }).catch(() => {});
      } else if (d.action === "warn") {
        await client.tui?.showToast?.({ body: { message: d.message, variant: "warning" } }).catch?.(() => {});
      } else gated.delete(sessionID);
    },
  };
};

