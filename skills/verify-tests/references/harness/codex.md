# Running the roles in Codex

Engine: `node "<plugin-root>/dist/tcheck.mjs"`. `tcheck env` prints the resolved path.

Codex custom agents can't be restricted to a single tool (a read-only sandbox still allows reads). So the **blind roles run out-of-process**, launched by the engine. The non-blind roles run in your own session.

| Role | How |
|---|---|
| spec-extractor | In-session. Print the payload (`tcheck spec prompt <run> <target>`), follow it yourself, write your full answer to a file, then `tcheck spec save <run> <target> --from <file>`. |
| blind-writer | `tcheck blind-run <bundle-id> --role writer`. The engine spawns `codex exec` in an empty temp dir outside the repo, with a read-only sandbox, and ingests the result. |
| repair | `tcheck blind-run <bundle-id> --role repair --run <run>` |
| adjudicator | In-session. Print `tcheck adjudicate prompt <run> <test>`, answer it, write it to a file, then `tcheck adjudicate save <run> <test> --from <file>`. |

You never see or relay the blind payload: the engine reads the frozen bundle itself. Don't `cat` bundle files into your context.

## Isolation strength

`codex exec` in a temp dir is medium-strength isolation, because the sandbox can still read absolute paths. Optionally, if the user has an API key and sets `blind.backend: api`, the engine calls the model API directly, with no tools and zero read surface. This is opt-in only; the default runs on the user's Codex/ChatGPT login. `tcheck env` shows which backend is active.

## Enforcement

`hooks/claude-codex-hooks.json` is loaded by the Codex plugin:

- **protect-tests (PreToolUse on apply_patch / edit tools):** blocks edits to protected tests.
- **stop-gate (Stop):** as configured.
- **handoff-guard:** not needed here, since the blind payload never passes through you.
