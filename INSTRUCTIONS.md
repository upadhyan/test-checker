# Instructions for Claude Code: build test-checker

You're building the code for **test-checker**, a multi-harness agent plugin that verifies LLM-written unit tests (blind spec-first generation plus dual-version execution, from arXiv:2607.22883).

Everything that isn't code is already designed and in the repo: manifests, skills, agents, prompts, schemas and docs. Your job is to implement the code against those files, verify the assumptions marked VERIFY, and leave the repo working end to end. Work through the phases in order. Commit at the end of each phase.

---

## Phase 0: Housekeeping (do first)

1. Read these, in this order:
   - `docs/BUILDING.md`: the rules;
   - `docs/engine-spec.md`: **the contract**;
   - `docs/plugin-design.md`: the reasoning;
   - `skills/verify-tests/SKILL.md` and everything under `skills/verify-tests/references/`;
   - `prompts/README.md`.
2. Create `.claude/CLAUDE.md` containing exactly one line: `@docs/BUILDING.md`.
3. Replace the placeholder `OWNER` everywhere (`grep -rn OWNER .`) with the user's GitHub username. Try `gh api user --jq .login`. If that fails, ask the user.
4. `git add -A && git commit -m "Design: manifests, skills, agents, prompts, specs"` (the repo is already `git init`ed).
5. Run `npm install` for dev dependencies (esbuild, typescript, @types/node).

## Phase 1: Engine foundations

Implement in `src/` (TypeScript), bundled to `dist/tcheck.mjs` by `npm run build`:

- CLI skeleton with global flags and exit codes (engine-spec §5).
- Config loading. You need a small YAML parser that handles the example configs; write one or vendor a tiny MIT one into `src/vendor/`. Validate against `skills/verify-tests/references/config.schema.json`.
- Repo discovery and the `.test-checker/` state layout (§3); ledger append and `state.json` (§10).
- Commands: `env` (§4), `init`, `doctor`, `status`, `scope`.

**Done when** `node dist/tcheck.mjs env --json` and `init` work in a scratch git repo, and `doctor` passes on a Python scratch repo using `examples/config.python.yaml`.

## Phase 2: Execution and classification (no models yet)

- `WORKTREE` snapshot and worktree management (§8.1).
- `run start`, `target add`, `compose`, `exec`: worktrees, setup and compile, runs with flake reruns, JUnit XML parsing (file or directory), timeouts (§8.2–8.3).
- Repairable-error filtering and redaction (§8.4).
- `classify` for all three modes (§8.5); `report` (§12); `promote`, `waive`.
- Build the five fixtures described in `docs/fixtures-spec.md` (`fixtures/<name>/` with `fixture.yaml`, `config.yaml`, `buggy/`, `fixed/`).

**Done when** hand-written tests dropped into a run for `off_by_one` classify correctly: one test that catches the bug → `effective`; one that asserts the buggy value → `misguided`.

## Phase 3: Leak check and payloads (the core of the method)

- Leak check exactly per §6: line test, shingle test, common-line exclusion, redact mode.
- Template renderer per `prompts/README.md`:
  - unknown variables are errors;
  - `{{#if}}` and variant blocks work;
  - static refusal to render `target.*` in writer or repair templates.
- Payload format, hashing, storage and single-use semantics (§7).
- `context set`, `spec prompt|save|show|edit`, `bundle build|emit`, `ingest`, `adjudicate queue|prompt|save|override`.

**Done when** unit tests (`node --test tests/`) cover every invariant in §1. At minimum:

- a spec that quotes a body line is rejected;
- context containing the body is rejected;
- a repair payload never contains `<failure>` text or body lines;
- a consumed payload can't be reused.

## Phase 4: MCP server and hooks (Claude Code pathway)

- `tcheck mcp`: a stdio MCP server with `submit_tests`, `save_spec` and `save_verdict` (§9). It's already declared inline in `.claude-plugin/plugin.json`.
- `tcheck hook <event>` for session-start, handoff-guard, protect-tests and stop-gate, with Claude Code output formats (§13).
  - Every hook has a fast path that exits immediately when the repo has no config.
  - Hooks fail open, except handoff-guard.
- Load the plugin locally: `claude --plugin-dir .`.
- **VERIFY 1 (critical):** run `/mcp` and read the real tool names of the tcheck server. Make the `tools:` line in each `agents/*.md` match exactly. If they don't match, the subagents get zero tools and Claude Code refuses to launch them. Update engine-spec §9 with the confirmed format.
- **VERIFY 2:** confirm `CLAUDE_PROJECT_DIR` is set for the plugin MCP server process, and fix repo discovery if not.
- **VERIFY 3:** confirm the PreToolUse input for the Agent tool carries `tool_input.subagent_type` as `test-checker:tcheck-blind-writer` (plugin-scoped name).

**Done when** you can run the full `verify-tests` skill in Claude Code on the `off_by_one` fixture:

- the spec-extractor, blind-writer and adjudicator subagents launch and save through their tools;
- the handoff guard blocks a hand-edited payload;
- protect-tests blocks editing a generated test;
- the report is produced.

## Phase 5: Headless backends and selftest

- `blind-run` with backends `claude` (headless `claude -p`, which runs on the user's subscription login), then `codex` (`codex exec`, ChatGPT login), then `opencode` and `pi`. Last, the optional `api` backend (Anthropic Messages API or OpenAI Responses API, no tools) for people who have a key (§11). **No API key is required anywhere.** The user runs on a subscription.
- **VERIFY 4:** the exact CLI flags for running `claude -p` and `codex exec` with no tools or a read-only sandbox in a temp dir. Record them in engine-spec §11.
- `selftest` (§14) with the criteria from `docs/fixtures-spec.md`.

**Done when** `node dist/tcheck.mjs selftest` (default backend `claude`, the user's subscription) runs all five fixtures and prints the blind vs baseline table. Report the results to the user, even if criterion 3 only warns. The selftest makes roughly 30–40 model calls, so tell the user before running it, since it uses subscription quota.

## Phase 6: Codex pathway

- Confirm `hooks/claude-codex-hooks.json` loads under Codex.
- **VERIFY 5:** whether Codex expands `${CLAUDE_PLUGIN_ROOT}` (ponytail relies on this) or needs `PLUGIN_ROOT`. Adjust the hook commands if needed.
- **VERIFY 6:** Codex's edit-tool name (`apply_patch`?) and whether it accepts `systemMessage` / `additionalContext`. Fix the output mapping in §13.
- **VERIFY 7:** Codex harness detection env vars (§4).
- Walk through `skills/verify-tests/references/harness/codex.md` for real, if Codex is installed.

## Phase 7: OpenCode and Pi integrations

- `.opencode/plugins/test-checker.mjs` per §15:
  - `config` hook registering the skills path and the four hidden deny-all agents (bodies from `agents/*.md`);
  - the three tools;
  - `shell.env`, `tool.execute.before`, and the end-of-turn gate.
  - **VERIFY 8:** OpenCode's end-of-turn event name, and how to allow exactly one custom tool for an agent.
- `pi-extension/index.mjs` per §15: the four model-calling tools, `tool_call`, `agent_end` and `before_agent_start`.
  - **VERIFY 9:** how a Pi extension makes a tool-less model call. Fall back to the `pi` headless backend (`pi -p` in a temp dir) if there's no supported way.
- Smoke-test each pathway if the harness is installed. Otherwise leave a clear TODO in the relevant harness reference file.

## Phase 8: Finish

- `npm run build && npm test && npm run validate` all pass.
- `npm run check:dist` passes (the committed `dist/` matches `src/`).
- Every VERIFY item is either confirmed (spec updated) or listed as open in a `## Open items` section at the end of `docs/engine-spec.md`.
- Add a `LICENSE` (MIT, author Nakul Upadhya) if one doesn't exist.
- Give the user a short summary:
  - what works in each harness;
  - selftest numbers;
  - open VERIFY items;
  - anything in the design you had to change, and why.

---

## Rules throughout

- **The spec is the contract.** If something in `docs/engine-spec.md` is wrong or can't be built, stop, explain, then change the spec and the code together. Don't silently diverge.
- **Don't change prompt wording in `prompts/`** without asking. It's research-derived.
- **Zero runtime dependencies and no native modules.** Users install the plugin by cloning; nothing runs `npm install` for them.
- **Nothing in the engine may assume a language.** Language specifics live in config, `examples/`, error-pattern defaults and `doctor` templates.
- **Never modify the user's working tree** outside `init` and `promote`.
- **Ask the user** before installing global tools or running anything that makes many model calls.
- **Never require an API key.** Every default must work on a Claude or ChatGPT subscription through the harness itself (native subagents, or the harness's headless CLI). The `api` backend is opt-in only.
