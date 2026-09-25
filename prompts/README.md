# Prompts

These files are the single source of truth for every model-facing instruction in test-checker. Agent files (`agents/*.md`) are short role cards. The actual task text always arrives as a **payload** rendered by the engine from these files, so every harness gets identical wording.

| File | Used by | Rendered by |
|---|---|---|
| `spec-extract.base.md` | spec-extractor (`spec.prompt: base`) | `tcheck spec prompt <target>` |
| `spec-extract.advanced.md` | spec-extractor (`spec.prompt: advanced`, the default) | `tcheck spec prompt <target>` |
| `blind-write.md` | blind writer | `tcheck bundle emit <id> --role writer` |
| `repair.md` | repair agent | `tcheck bundle emit <id> --role repair --run <run>` |
| `adjudicate.md` | adjudicator | `tcheck adjudicate prompt <run> <test>` |
| `code-aware-baseline.md` | selftest baseline only (the paper's code-based setting) | `tcheck selftest` |

## Template syntax

- `{{name}}`: variable substitution. Unknown variables are a render error, never left in place.
- `{{#if name}} … {{/if}}`: included only when the variable is set and non-empty.
- Blocks marked `<!-- variant: X -->` … `<!-- /variant -->` are selected by the engine; other variants are dropped.

## Provenance

`spec-extract.*` and `code-aware-baseline.md` follow the prompts in Zhao, Zhou & Cohen (arXiv:2607.22883), Figures 2–3. Java-specific wording is generalised to `{{language}}` / `{{framework}}`. Additions beyond the paper are marked `[tc]` in comments.

## Variables the renderer must provide

| Variable | Source |
|---|---|
| `language`, `language_tag`, `framework`, `test_file_pattern` | config |
| `target.symbol`, `target.file`, `target.body` | `target.json` plus the body from the relevant revision. **Never available to `writer` or `repair` renders.** |
| `context_markdown` | `context.json` rendered as readable markdown (signatures in code fences) |
| `bundle.*` | frozen bundle fields, e.g. `bundle.focal.signature`, `bundle.spec`, `bundle.context.test_conventions.imports` |
| `bundle_context_markdown` | `bundle.context` rendered as markdown |
| `intent_hint` | `spec prompt --intent` |
| `payload_id` | assigned at emit time |
| `submit_via_tool` / `submit_via_text` | exactly one is set, by consumer (engine-spec §7) |
| `previous_tests_markdown`, `filtered_errors`, `round`, `max_rounds` | repair only; errors per engine-spec §8.4 |
| `spec`, `analysis`, `test_source`, `failure_output`, `revision` | adjudicate only |

The renderer must refuse to render `writer` or `repair` templates if any `target.*` variable is referenced. This is a static check on the template.
