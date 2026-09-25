# BUILDING.md: brief for building test-checker with Claude Code

> Point Claude Code at this file. For example, create `.claude/CLAUDE.md` containing the single line `@docs/BUILDING.md`. The file isn't at the repo root because `claude plugin validate --strict` flags a root `CLAUDE.md`.

This repo is a multi-harness agent plugin. The non-code parts (manifests, skills, agents, prompts, schemas, docs) are designed and in place. Your job is the code: the `tcheck` engine and the thin OpenCode and Pi integrations.

## Read first

1. `docs/engine-spec.md`: **the contract.** Implement it; don't redesign it. If something in it is wrong or unbuildable, stop and raise it, then update the spec in the same change.
2. `docs/plugin-design.md`: why things are shaped this way.
3. `skills/verify-tests/SKILL.md` and `references/`: how agents will call the engine. Every command the skill mentions must exist, with the flags shown.

## What to build

| Path | What |
|---|---|
| `src/**/*.ts` | Engine source |
| `dist/tcheck.mjs` | Bundled engine (`npm run build`). **Committed.** Zero runtime deps, and no native modules. |
| `.opencode/plugins/test-checker.mjs` | OpenCode integration (engine-spec §15) |
| `pi-extension/index.mjs` | Pi integration (engine-spec §15) |
| `fixtures/*` | Selftest fixtures (`docs/fixtures-spec.md`) |
| `tests/*.test.js` | `node --test` unit tests, one or more per invariant in engine-spec §1 |

## Build order

1. Config load and validation, `env`, `init`, `doctor`, ledger, state.
2. Worktree snapshot and exec (engine-spec §8): JUnit parsing, flake reruns, classification. Test against a fixture with hand-written tests before any model is involved.
3. Leak check (§6) and payload rendering (§7), with thorough unit tests. This is the core of the method.
4. Targets, context, spec save, bundle build and emit, ingest, the MCP server (§9).
5. Hooks (§13) with Claude Code output mapping.
6. Report, promote, waive.
7. `blind-run` backends (§11), starting with `claude`, then `codex`, `opencode` and `pi`; `api` last and opt-in. Then `selftest`.
8. OpenCode integration, then the Pi integration.

## Rules

- **Don't hand-edit `dist/`.** Run `npm run build`. CI runs `npm run check:dist`.
- **Don't change prompt wording casually.** `prompts/` holds research-derived text; see `prompts/README.md`. Template variables used in prompts must be provided by the renderer, and unknown variables are errors.
- **Keep the agent files' `tools:` lines in sync with the real MCP tool names** (engine-spec §9, VERIFY item). A mismatch means zero tools, and the subagent won't launch.
- **Hooks must be fast (< 300 ms) and fail open,** except handoff-guard, which fails closed.
- **Nothing in the engine may assume a language.** Language-specific behaviour lives in config, `examples/`, `repair_error_patterns` defaults, and the `doctor` templates.

## Checks before any PR

```
npm run build && npm test
claude plugin validate .claude-plugin/plugin.json --strict && claude plugin validate .
node dist/tcheck.mjs selftest                    # uses `claude -p` on your subscription; ~30–40 model calls
```

## Dogfooding note

The tcheck MCP server is declared inline in `.claude-plugin/plugin.json` using `${CLAUDE_PLUGIN_ROOT}`, which is only set when loaded as a plugin. To test locally, run `claude --plugin-dir .` from the repo root.
