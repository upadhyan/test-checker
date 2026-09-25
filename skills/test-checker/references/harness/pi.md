# Running the roles in Pi

Engine: loaded in-process by the Pi extension. The shell form `node "<package-dir>/dist/tcheck.mjs"` also works; `tcheck env` prints it.

Pi has no subagents. The extension registers tools that make a **direct model call with no tools attached**. Only the extension reads the bundle, so the blind model never sees anything else.

| Role | Tool | Argument |
|---|---|---|
| spec-extractor | `tcheck_spec` | `{ run, target }` |
| blind-writer | `tcheck_blind_generate` | `{ bundle_id }` |
| repair | `tcheck_blind_repair` | `{ bundle_id, run }` |
| adjudicator | `tcheck_adjudicate` | `{ run, test_id }` |

Each tool renders its own payload, calls the model, and saves the result. It returns a one-line summary. You never handle payloads in Pi.

Model: the session's current model, unless config sets `blind.model`.

## Enforcement

- **`tool_call` handler:** protect-tests on edit and write tools.
- **`agent_end` handler:** stop-gate, following `gate` in config.
