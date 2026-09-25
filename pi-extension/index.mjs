// Pi integration for test-checker (engine-spec §15). The model-calling tools render payloads in code and
// call the model with no tools, so the orchestrating agent never composes a blind role's input.
import { Type } from "typebox";
import { Repo, findRoot, evaluateHook, runBackend, specPrompt, specSave, bundleEmit, ingest, adjudicatePrompt, adjudicateSave } from "../dist/tcheck.mjs";

process.env.TCHECK_HARNESS = "pi";

function repoAt(cwd) {
  const root = findRoot({ cwd, gitFallback: false });
  if (!root) throw new Error("no .test-checker/config.yaml in this project; run the test-checker-setup skill first");
  return Repo.open({ root });
}

/**
 * VERIFY 9 (confirmed against pi 0.84 docs, examples/extensions/summarize.ts): ctx.modelRegistry.complete(model, {messages})
 * is a tool-less completion. Falls back to the headless `pi -p --no-tools` backend.
 */
async function complete(ctx, prompt, repo) {
  // blind.model (provider/id) overrides the session model.
  const [prov, id] = (repo?.config.blind.model ?? "").split("/");
  const model = (prov && id && ctx.modelRegistry?.find?.(prov, id)) || ctx.model;
  if (model && ctx.modelRegistry?.complete) {
    const res = await ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { cacheRetention: "none" });
    const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (text.trim()) return text;
  }
  return runBackend("pi", prompt, { model: repo?.config.blind.model });
}

const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });
const guard = (fn) => async (_id, params, _signal, _onUpdate, ctx) => {
  try {
    return text(await fn(params, ctx));
  } catch (e) {
    return text(`ERROR: ${e?.message ?? e}`);
  }
};

export default function (pi) {
  pi.registerTool({
    name: "tcheck_spec",
    label: "test-checker: spec",
    description: "Derive the intended specification of a registered target (test-checker spec-extractor role). Saves the spec and returns it.",
    parameters: Type.Object({ run: Type.String(), target: Type.String(), intent: Type.Optional(Type.String()) }),
    execute: guard(async ({ run, target, intent }, ctx) => {
      const repo = repoAt(ctx.cwd);
      const p = specPrompt(repo, run, target, intent);
      const r = specSave(repo, run, target, await complete(ctx, p.full, repo));
      return `Spec saved for ${target}. Leak check: passed.\n\n${r.spec}`;
    }),
  });

  const blind = (role) =>
    guard(async ({ bundle_id, run }, ctx) => {
      const repo = repoAt(ctx.cwd);
      const p = bundleEmit(repo, bundle_id, role, { run, via: "text" });
      return ingest(repo, p.payload, await complete(ctx, p.full, repo)).message;
    });

  pi.registerTool({
    name: "tcheck_blind_generate",
    label: "test-checker: blind tests",
    description: "Write unit tests for a frozen test-checker bundle WITHOUT the implementation. Pass only the bundle id; the payload is loaded in code.",
    parameters: Type.Object({ bundle_id: Type.String(), run: Type.Optional(Type.String()) }),
    execute: blind("writer"),
  });

  pi.registerTool({
    name: "tcheck_blind_repair",
    label: "test-checker: blind repair",
    description: "Fix compile/import/setup errors in blind tests for a bundle, without the implementation or assertion failures.",
    parameters: Type.Object({ bundle_id: Type.String(), run: Type.Optional(Type.String()) }),
    execute: blind("repair"),
  });

  pi.registerTool({
    name: "tcheck_adjudicate",
    label: "test-checker: adjudicate",
    description: "Decide whether a failing blind test or the code is wrong (test-checker adjudicator role). Saves and returns the verdict.",
    parameters: Type.Object({ run: Type.String(), test_id: Type.String() }),
    execute: guard(async ({ run, test_id: test }, ctx) => {
      const repo = repoAt(ctx.cwd);
      const p = adjudicatePrompt(repo, run, test);
      return adjudicateSave(repo, run, test, await complete(ctx, p.full, repo)).message;
    }),
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!["edit", "write"].includes(event.toolName)) return;
    const d = evaluateHook({ event: "protect-tests", tool: event.toolName, input: event.input, cwd: ctx.cwd });
    if (d.action === "deny") return { block: true, reason: d.reason };
  });

  let nudged = false; // one follow-up per stretch of unverified work, to avoid loops
  pi.on("agent_end", async (_event, ctx) => {
    const d = evaluateHook({ event: "stop-gate", cwd: ctx.cwd, stopHookActive: nudged });
    if (d.action === "block") {
      nudged = true;
      pi.sendUserMessage(d.reason, { deliverAs: "followUp" });
    } else if (d.action === "warn") ctx.ui?.notify?.(d.message, "warning");
    else nudged = false;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const d = evaluateHook({ event: "session-start", cwd: ctx.cwd });
    if (d.action === "context") return { systemPrompt: `${event.systemPrompt}\n\n${d.text}` };
  });
}
