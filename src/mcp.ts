import * as readline from "node:readline";
import { Repo, findRoot } from "./repo";
import { submitTests } from "./bundle";
import { specSave } from "./spec";
import { adjudicateSave } from "./adjudicate";
import { loadPayload, requireRole } from "./payload";
import { TcheckError, envMissing } from "./util";

/** Protocol versions we speak; the client's choice wins when we know it (VERIFY against current Claude Code). */
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INTERNAL = "For test-checker's internal roles only; never call this yourself.";

export const TOOLS = [
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
          items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
        },
        notes: { type: "string", description: "Optional: spec ambiguities noticed" },
      },
      required: ["payload_id", "files"],
    },
  },
  {
    name: "save_spec",
    description: `Save the spec-extractor's answer (the <analysis> and <spec> blocks) for a test-checker payload. ${INTERNAL}`,
    inputSchema: {
      type: "object",
      properties: { payload_id: { type: "string" }, raw_output: { type: "string", description: "The complete answer, including <analysis> and <spec>" } },
      required: ["payload_id", "raw_output"],
    },
  },
  {
    name: "save_verdict",
    description: `Save the adjudicator's verdict (<verdict>, <spec_basis>, <reason>) for a test-checker payload. ${INTERNAL}`,
    inputSchema: {
      type: "object",
      properties: { payload_id: { type: "string" }, raw_output: { type: "string", description: "The complete answer, including <verdict>, <spec_basis> and <reason>" } },
      required: ["payload_id", "raw_output"],
    },
  },
];

function openRepo(): Repo {
  const root = findRoot({});
  if (!root) throw envMissing("test-checker could not find the repository (CLAUDE_PROJECT_DIR is unset and cwd is not in a git repo)");
  return Repo.open({ root });
}

/** Run one tool call; the result text is what the role sees. Shared with the OpenCode integration. */
export function callTool(name: string, args: any, repo: Repo = openRepo()): string {
  const id = String(args?.payload_id ?? "");
  switch (name) {
    case "submit_tests":
      return submitTests(repo, id, args.files, args.notes).message;
    case "save_spec": {
      const { entry } = loadPayload(repo, id);
      requireRole(entry, ["spec"]);
      specSave(repo, entry.run, entry.target!, String(args.raw_output ?? ""));
      return `Spec saved for ${entry.target}. Leak check: passed.`;
    }
    case "save_verdict": {
      const { entry } = loadPayload(repo, id);
      requireRole(entry, ["adjudicate"]);
      return adjudicateSave(repo, entry.run, entry.test!, String(args.raw_output ?? "")).message;
    }
    default:
      throw new TcheckError(`unknown tool: ${name}`);
  }
}

export function handle(msg: any): any | undefined {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const isRequest = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tcheck", version: "0.1.0" },
        instructions: "test-checker's internal role tools. Only the test-checker subagents should call these.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      try {
        return reply({ content: [{ type: "text", text: callTool(name, args ?? {}) }], isError: false });
      } catch (e: any) {
        // Tool errors go back to the role as text so it can fix its submission.
        return reply({ content: [{ type: "text", text: `ERROR: ${e?.message ?? e}` }], isError: true });
      }
    }
    default:
      if (!isRequest) return undefined; // notifications (initialized, cancelled, …) need no answer
      if (msg.method === "resources/list") return reply({ resources: [] });
      if (msg.method === "prompts/list") return reply({ prompts: [] });
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

export function serve(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
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
    rl.on("close", () => resolve());
  });
}
