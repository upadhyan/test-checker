# Contributing

`docs/engine-spec.md` is the contract for the `tcheck` engine. If a change makes it wrong, update the spec in the same change. `docs/plugin-design.md` explains why things are shaped this way.

## Rules

- **Don't hand-edit `dist/`.** Run `npm run build`. CI runs `npm run check:dist`. `dist/tcheck.mjs` is committed, with zero runtime deps and no native modules.
- **Don't change prompt wording casually.** `prompts/` holds research-derived text; see `prompts/README.md`. Template variables used in prompts must be provided by the renderer, and unknown variables are errors.
- **Keep the agent files' `tools:` lines in sync with the real MCP tool names** (engine-spec §9). A mismatch means zero tools, and the subagent won't launch.
- **Hooks must be fast (< 300 ms) and fail open,** except handoff-guard, which fails closed.
- **Nothing in the engine may assume a language.** Language-specific behaviour lives in config, `examples/`, `repair_error_patterns` defaults, and the `doctor` templates.

## Checks before any PR

```
npm run build && npm test
claude plugin validate .claude-plugin/plugin.json --strict && claude plugin validate .
node dist/tcheck.mjs selftest                    # uses `claude -p` on your subscription; ~30–40 model calls
```

## Testing the plugin locally

The tcheck MCP server is declared inline in `.claude-plugin/plugin.json` using `${CLAUDE_PLUGIN_ROOT}`, which is only set when loaded as a plugin. Run `claude --plugin-dir .` from the repo root.
