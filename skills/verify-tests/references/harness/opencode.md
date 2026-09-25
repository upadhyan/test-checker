# Running the roles in OpenCode

Engine: `node "<package-dir>/dist/tcheck.mjs"`. `tcheck env` prints it. The OpenCode plugin also exposes the engine's tools natively.

At startup the plugin registers four hidden subagents through OpenCode's `config` hook. Each is `mode: subagent`, `hidden: true`, with every built-in permission set to `deny`, and each is allowed exactly one plugin tool.

| Role | Agent | Payload from | Result arrives via |
|---|---|---|---|
| spec-extractor | `tcheck-spec-extractor` | `tcheck spec prompt <run> <target>` | `tcheck_save_spec` tool |
| blind-writer | `tcheck-blind-writer` | `tcheck bundle emit <id> --role writer` | `tcheck_submit_tests` tool |
| repair | `tcheck-repair` | `tcheck bundle emit <id> --role repair --run <run>` | `tcheck_submit_tests` tool |
| adjudicator | `tcheck-adjudicator` | `tcheck adjudicate prompt <run> <test>` | `tcheck_save_verdict` tool |

How to launch: run the payload command, then invoke the agent through the **task** tool with the prompt set to exactly that output.

## Enforcement

The plugin's `tool.execute.before` handler does three things:

- **handoff-guard** on `task` for the blind agents: the prompt must be a frozen payload;
- **protect-tests** on edit and write tools;
- **stop-gate** at end of turn, following `gate` in config.
