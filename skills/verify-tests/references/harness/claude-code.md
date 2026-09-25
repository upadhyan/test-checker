# Running the roles in Claude Code (and Cowork)

Engine: `node "${CLAUDE_PLUGIN_ROOT}/dist/tcheck.mjs"`. `tcheck env` prints the resolved path.

Every role is a plugin subagent launched with the **Agent** tool. The prompt is the engine's payload, verbatim.

| Role | `subagent_type` | Payload from | Result arrives via |
|---|---|---|---|
| spec-extractor | `test-checker:tcheck-spec-extractor` | `tcheck spec prompt <run> <target>` | `save_spec` tool (automatic) |
| blind-writer | `test-checker:tcheck-blind-writer` | `tcheck bundle emit <id> --role writer` | `submit_tests` tool (automatic) |
| repair | `test-checker:tcheck-repair` | `tcheck bundle emit <id> --role repair --run <run>` | `submit_tests` tool (automatic) |
| adjudicator | `test-checker:tcheck-adjudicator` | `tcheck adjudicate prompt <run> <test>` | `save_verdict` tool (automatic) |

How to launch:

1. Run the payload command with Bash and capture stdout.
2. Call Agent with `subagent_type` as above and `prompt` set to **exactly** that stdout. Add no preface, and don't summarise or trim.
3. When the subagent replies, continue with the next step. The engine already has the result.

Targets in one run are independent, so you can launch their spec-extractor and blind-writer subagents in parallel.

## Enforcement in this harness

- **handoff-guard hook (PreToolUse on Agent):** rejects a blind-writer or repair launch whose prompt isn't a frozen payload (hash check).
- **Blind subagents have one tool,** `submit_tests`. They can't read files. If the tcheck MCP server isn't running (for example, Node is missing), Claude Code refuses to launch them. That failure is intended.
- **protect-tests hook:** blocks edits to generated or promoted tests without a `test-wrong` verdict or a user override.
- **stop-gate hook:** follows `gate` in config (`off` | `warn` | `block`).

## Cowork

Same plugin, same steps. Cowork runs in a sandboxed VM:

- If `tcheck env` reports `node: missing`, the engine can't run, so tell the user test-checker needs Node in the Cowork environment. Do not improvise the loop by hand.
- If hooks don't fire (`tcheck env` shows `hooks_seen: false` after one tool call), the guards are off. Follow the non-negotiable rules strictly. The engine still re-checks payload hashes when results arrive.
