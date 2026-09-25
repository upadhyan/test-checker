# tcheck Engine Specification

The contract for `dist/tcheck.mjs`: the CLI, the MCP server, the hook evaluator, and the library API the OpenCode and Pi integrations import. Build it from `src/` (TypeScript), bundled by esbuild into one committed file with zero runtime dependencies.

Companion docs:

- `plugin-design.md`: why things are shaped this way.
- `skills/test-checker/`: the agent-facing procedure that drives these commands.
- `prompts/`: the templates this engine renders.

Items marked **VERIFY** depend on harness behaviour that must be confirmed during the build.

---

## 1. Invariants

These hold for every code path. Tests in `tests/` should cover each one.

1. **No body in blind inputs.** Nothing rendered for the `writer` or `repair` roles contains lines from a target's body (§6). This covers bundles, payloads, repair error text and notes.
2. **Blind inputs are frozen files.** Writer and repair payloads are rendered from a frozen bundle, written to disk, and hashed. Every consumer checks the hash: the MCP tools, the handoff guard, `ingest` and `blind-run`.
3. **Repair never sees assertion outcomes.** Only errors classified `repairable` (§8.4) reach the repair payload, and those are redacted.
4. **The user's working tree is never modified** except by `promote` and `init`. All execution happens in worktrees under `.test-checker/worktrees/`.
5. **Every state change is appended to the ledger** (§10). Reports and hooks read state from the ledger and `state.json`, never from memory.
6. **Deterministic, parseable output.** Every command supports `--json`. Human output goes to stdout; diagnostics go to stderr.

## 2. Runtime requirements

- Node ≥ 20 and git ≥ 2.30 on PATH. `tcheck env` reports both.
- No native modules and no runtime npm dependencies. YAML parsing, JSON Schema validation (a subset suffices), the JUnit XML parser, the MCP stdio server and HTTP calls are all bundled or hand-written.
- Works on macOS, Linux and Windows. Use `node:path` everywhere and never hard-code `/`. Spawn commands through a shell (`sh -c` / `cmd /c`), because configs are shell strings.

## 3. Repo discovery and state layout

**Repo root.** Resolved in this order:

1. `--root` flag;
2. `CLAUDE_PROJECT_DIR`;
3. walking up from cwd to the first directory containing `.test-checker/config.yaml`;
4. `git rev-parse --show-toplevel`.

```
.test-checker/
├── config.yaml               # committed
├── ledger.jsonl              # committed (append-only event log)
├── state.json                # committed: verified snapshot, hooks_seen, waivers
├── reports/<run>.md|.json    # committed
├── runs/<run>/               # ignored
│   ├── run.json              # mode, revisions, targets, status
│   ├── targets/<target>/
│   │   ├── target.json       # file, symbol, lines, rev, body_sha
│   │   ├── context.json
│   │   ├── spec.raw.md       # full spec-extractor output
│   │   ├── spec.md           # extracted <spec> (user-editable via `spec edit`)
│   │   └── analysis.md       # extracted <analysis>
│   ├── exec/<n>/<rev-label>/<rerun>/junit.xml|…  # raw results; <n> counts exec invocations
│   ├── results.json          # merged per-test outcomes
│   └── classification.json
├── bundles/<bundle>.json     # ignored, frozen
├── payloads/<payload>.md     # ignored, frozen rendered prompts
├── payloads/index.json       # payload → {role, bundle, run, target, sha256, consumed}
├── generated/<run>/<target>/round-<n>/…     # ignored, submitted test files
└── worktrees/_cache/<sha>/   # ignored, git worktrees, one per commit, shared by runs (§8.1)
```

**Ids:**

| Kind | Format | Example |
|---|---|---|
| run | `r-YYYYMMDD-HHMMSS-<4 hex>` | `r-20260925-201500-a3f9` |
| target | `<slug of file>--<slug of symbol>` | `src-stats-py--mean` |
| bundle | `b-<run short>-<target>` | `b-a3f9-src-stats-py--mean` |
| payload | `p-<8 hex>` | `p-1c9e04ab` (random; single-use for writer and repair) |
| test | `<target>::<junit classname>::<junit name>` | `src-stats-py--mean::test_mean_1::test_empty_raises` |

## 4. Harness detection (`tcheck env`)

Precedence:

1. `--harness` flag;
2. `TCHECK_HARNESS` env var (set by the OpenCode plugin via its `shell.env` hook, and by the Pi extension on `process.env`);
3. heuristics;
4. `unknown`.

| Harness | Heuristic |
|---|---|
| `claude-code` | `CLAUDECODE=1` (confirmed, Claude Code 2.1), or `CLAUDE_PLUGIN_ROOT` set without Codex markers |
| `cowork` | `claude-code` signals plus `CLAUDE_CODE_ENTRYPOINT` containing `cowork` (**VERIFY**: the marker is unconfirmed). Otherwise treated as `claude-code`. |
| `codex` | `PLUGIN_ROOT` set, or any `CODEX_*` variable other than `CODEX_HOME`. Codex gives plugin hooks both `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` (Codex hooks docs), so Codex markers win over a bare `CLAUDE_PLUGIN_ROOT`. Which `CODEX_*` variables reach shell-tool processes is **VERIFY 7** (open). |
| `opencode` | via `TCHECK_HARNESS` only |
| `pi` | via `TCHECK_HARNESS` only |

`tcheck env --json` output:

```json
{
  "harness": "claude-code",
  "engine": "node \"/…/test-checker/dist/tcheck.mjs\"",
  "plugin_root": "/…/test-checker",
  "harness_reference": "/…/skills/test-checker/references/harness/claude-code.md",
  "node": "22.4.0", "git": "2.46.0",
  "repo_root": "/…/myrepo", "config": "present|missing|invalid",
  "blind_backend": "native|api|codex|claude|opencode|pi|none",
  "blind_isolation": "strong|medium|none",
  "hooks_seen": true,
  "gate": "warn",
  "dirty_files": 2,
  "warnings": []
}
```

`hooks_seen` is true if any `tcheck hook` invocation has recorded itself in `state.json` during the last 24 h.

## 5. CLI reference

Global flags: `--json`, `--root <dir>`, `--harness <name>`, `--quiet`.

| Exit code | Meaning |
|---|---|
| 0 | OK |
| 1 | Usage or config error |
| 2 | Rejected by a check (leak, hash mismatch, schema) |
| 3 | Environment missing (node, git, repo, backend) |
| 4 | A configured command failed unexpectedly |

### Setup and diagnostics

| Command | Behaviour |
|---|---|
| `env` | §4 |
| `init [--language L] [--framework F] [--force]` | Writes `.test-checker/config.yaml` from the closest `examples/config.*.yaml`. Creates `.test-checker/` and a `.gitignore` inside it covering the ignored paths. Refuses to overwrite without `--force`. |
| `doctor [--use PATHS…]` | Validates config against `config.schema.json`. In a scratch worktree, writes a trivial passing and a trivial failing test (language templates: see below), runs `setup` / `compile` / `run`, and checks that JUnit is produced with 1 pass + 1 fail. Prints concrete fixes. |
| `status` | Dirty files, open runs, unresolved verdicts, gate mode |
| `scope [--since <rev>]` | JSON list of changed files matching `source_globs` (vs `HEAD`, or `--since`), with hunks `{file, ranges:[[a,b]]}` and whether each is already verified |

**`doctor` trivial tests.** `doctor` needs a minimal pass/fail test per framework. Ship small templates for pytest, unittest, jest/vitest, go test, JUnit 4/5, cargo test and xUnit. For anything else, ask the agent (via an error message) to write two trivial tests to a path the engine names, and re-run with `doctor --use <paths>`.

### Run lifecycle

| Command | Behaviour |
|---|---|
| `run start --mode bugfix\|new\|audit [--buggy REV] [--fixed REV\|WORKTREE] [--existing PATHS…]` | Creates the run and resolves revisions to commits: `WORKTREE` is snapshotted per §8.1. Prints the run id. |
| `target add <run> <file>::<symbol> --lines A-B [--rev REV]` | Records the target. Reads the body from the spec-source revision (§8.1) and stores `body_sha` plus the normalised body lines used by the leak check. Errors if the range is empty or outside the file. |
| `context set <run> <target> --file ctx.json` | Validates against the `context` part of `bundle.schema.json` and runs the leak check (§6). Exit 2 on leak, printing the offending lines. |
| `spec prompt <run> <target> [--intent TEXT]` | Renders `spec-extract.<prompt>.md` (variant per config) with the target body and context, as a payload (§7, role `spec`). |
| `spec save <run> <target> --from FILE` | Parses `<analysis>` and `<spec>` (for the scaffold variant, Part 3 if tags are absent). Runs the leak check on the spec, then saves. Exit 2 if the spec quotes the body: the agent must re-run or edit the spec. |
| `spec show <run> <target>` / `spec edit <run> <target> --from FILE` | Print the spec, or replace it (re-leak-checked). Editing invalidates existing bundles for that target. |
| `bundle build <run> <target>` | Assembles focal + spec + context + meta and validates the schema and leak check. Freezes to `bundles/<id>.json`. Prints the bundle id. |
| `bundle emit <bundle> --role writer\|repair [--run RUN] [--via tool\|text]` | Renders the payload (§7) and prints it to stdout, exactly. `--via` picks `submit_via_tool` (default, native subagents) or `submit_via_text`. For repair, requires the latest exec of that target to have repairable errors (§8.4) and fewer than `refine_rounds` repair rounds so far. Refuses a bundle whose spec was edited after it was built. |
| `blind-run <bundle> --role writer\|repair [--run RUN] [--backend B]` | Out-of-process path (§11). Renders the payload internally, runs the backend, then ingests. Never prints the payload. |
| `ingest <payload> --from FILE\|-` | Parses `FILE:` + fenced blocks (and `NOTES:`) from text-returning backends, then stores them like `submit_tests` (§9). |
| `compose <run>` | Resolves the latest submitted round per target to final paths (`test_dir`, `test_file_pattern`). Writes them to `runs/<run>/composed/` and records the file map. |
| `exec <run>` | §8. Prints per-target status: `ok`, `needs_repair` (with a count) or `failed_setup`. |
| `classify <run>` | §8.5. Writes `classification.json` and queues tests for adjudication. |
| `adjudicate queue <run>` | Lists queued tests with category and reason |
| `adjudicate prompt <run> <test>` | Renders `adjudicate.md` as a payload (role `adjudicate`), using the implementation from the relevant revision (fixed side in bugfix mode) and the failure text (unredacted: the adjudicator is not blind). |
| `adjudicate save <run> <test> --from FILE` | Parses `<verdict>`, `<spec_basis>` and `<reason>`. Rejects `code-wrong` with `spec_basis: none` by downgrading it to `spec-ambiguous`, with a warning. |
| `adjudicate override <run> <test> --verdict V --reason TEXT` | Records a user decision. Takes precedence over the model verdict. |
| `report <run>` | §12 |
| `promote <run> [--tests IDS…] [--all-accepted] [--force]` | Copies accepted tests (effective, plus neutral if chosen) to `promote_dir`, rewriting paths per pattern. Registers them as protected. Updates the verified snapshot for the run's target files (the blob that was tested: fixed side in bugfix, the current snapshot otherwise). Refuses if unresolved `code-wrong` or `spec-ambiguous` verdicts exist, unless `--force`. Promotion is **per file**, because test files can't be sliced language-agnostically: a file qualifies only if every test in it is acceptable (bugfix: effective or neutral; new/audit: accepted; none quarantined) and it holds a selected test (effective/accepted by default, any acceptable test with `--all-accepted`, or the ids in `--tests`). The report names files that don't qualify and why; after a `test-wrong` verdict the agent may delete the bad test from the generated file and re-run `compose`/`exec`. |
| `waive <path…> --reason TEXT` | Marks the current content hash of the given files as verified without a run (ledger `waived`) |

### Integration entry points

| Command | Behaviour |
|---|---|
| `hook <event> [--harness H]` | §13. Reads the harness's hook JSON on stdin and writes the harness's expected output. |
| `mcp` | §9. Stdio MCP server. |
| `selftest [--backend B] [--fixtures NAMES…]` | §14 |

## 6. Leak check

Applied to:

- context (`context set`);
- spec (`spec save`, `spec edit`);
- the whole bundle (`bundle build`);
- every rendered writer and repair payload;
- repair error text, where it redacts instead of rejecting.

**Normalisation** of a line:

1. Strip leading and trailing whitespace.
2. Collapse internal whitespace to single spaces.
3. Drop trailing `;` and `,`.

**Significant body lines.** Normalised body lines of length ≥ 12, excluding:

- the signature lines: leading decorator, attribute and comment lines, then the declaration up to the line where its brackets balance, plus a lone `{` on the next line (Allman style);
- lines that are only brackets or keywords (`}`, `end`, `else:`, `try:`, `return`, `pass`, …);
- comment and docstring lines (`#`, `//`, `/*`, `*`, `--`, `;;`, `"""…"""`): they describe intent, not implementation, and specs legitimately reuse their wording;
- the 200 most common lines across the repo's source files **that occur in at least two files** (a line unique to one file is never boilerplate). This is computed once per run and stops boilerplate like `return result` from triggering. Cache it in `runs/<run>/common-lines.json`.

The shingle test also ignores comment and docstring lines.

**Two tests:**

1. **Line test.** Any significant body line appearing as a substring of the checked text (itself normalised line by line) fails the check.
2. **Shingle test.** Tokenise body and text on `\W+`. Take 6-token shingles. If more than 25% of the body's shingles appear in the text, the check fails. The threshold is configurable as `leak.shingle_threshold`.

On failure, report the offending lines with their locations.

**In repair error text,** offending lines are replaced by `[line from implementation redacted]` instead of rejecting.

## 7. Payloads

```
<<<TCHECK-PAYLOAD v1 id=p-1c9e04ab role=writer sha256=5b1f…e2>>>
…rendered prompt…
<<<END TCHECK-PAYLOAD>>>
```

- **Hashing:** `sha256` covers the rendered prompt bytes between the header line and the end line (LF line endings, no trailing newline).
- **Storage:** the full text, header and footer included, is written to `payloads/<id>.md`. It's registered in `payloads/index.json` with `role`, `bundle`, `run`, `target`, `round`, `consumed: false`.
- **Roles:**
  - `spec` and `adjudicate` payloads are informational. They aren't blind, and hashing them only aids debugging.
  - `writer` and `repair` payloads are **single-use**. The first successful submission marks them consumed.
- **Rendering:**
  - Unknown `{{var}}` is an error.
  - `{{#if x}}` blocks are dropped when `x` is empty.
  - Variant blocks are chosen from config; `spec.variant: auto` selects `reasoning` (every harness model is a reasoning model; `scaffold` is for base models, paper §8.1).
  - HTML comments (`<!-- [tc] … -->`) are stripped from the rendered prompt.
  - `submit_via_tool` is set when the consumer is a native subagent with the MCP tool (Claude Code, OpenCode). `submit_via_text` is set for `blind-run` backends and the Pi extension.

## 8. Execution

### 8.1 Revisions and worktrees

- **`WORKTREE` snapshot.** Create a commit object without touching the user's index:
  1. `GIT_INDEX_FILE=<tmp> git read-tree HEAD`
  2. `git add -A -- . ':!.test-checker'`
  3. `git write-tree`
  4. `git commit-tree <tree> -p HEAD -m tcheck-snapshot`
  5. Store the commit under `refs/tcheck/<run>/worktree`.

  This includes untracked files.
- **Worktrees.** Each commit gets one worktree, `git worktree add --detach .test-checker/worktrees/_cache/<sha> <sha>`, shared by every run and label that uses that commit (mutants use `_cache/<sha>-mutant`). Before each use the engine removes the files it composed last time and runs `git checkout -- .`; untracked build output (e.g. `node_modules` from `commands.setup`) is kept, and `setup` runs once per worktree. Cached worktrees are not removed on report; delete `.test-checker/worktrees/` to reclaim space.
- **Re-snapshot.** On every `exec` after the first, labels given as `WORKTREE` are snapshotted again (ledger `revision_refreshed`), so a code fix made after a `code-wrong` verdict is what gets tested.
- **Spec-source revision:**

  | Mode | Revision |
  |---|---|
  | `bugfix` | `fixed` (default) or `buggy` (`spec.source`) |
  | `new` | `current` |
  | `audit` | `current` |

- **Revision labels per mode:**

  | Mode | Labels |
  |---|---|
  | `bugfix` | `buggy`, `fixed` |
  | `new` | `current`, plus `mutant-*` if mutation is enabled |
  | `audit` | `current` |

### 8.2 Compose into worktrees

Copy composed test files into each worktree at their final paths. Run `commands.setup` once per fresh worktree, then `commands.compile` if set. A compile failure is recorded as a round-level repairable error (§8.4) for all tests in that target.

### 8.3 Run and flake handling

1. **Run.** For each label, run `commands.run` `flake_reruns` times, with `{files}` = composed paths for all targets in the run, and `{junit}` = `exec/<round>/<label>/<k>/junit.xml` (or a directory).
2. **Parse.** Read all JUnit XML found. Outcome per testcase:
   - `pass`;
   - `failure` (`<failure>`);
   - `error` (`<error>`);
   - `skipped`.

   A test file that produced no testcases at all while its command failed counts as a load error for that file, unless another file's own repairable testcase error explains the abort (pytest stops the whole session on one bad file).
3. **Flake rule.** A test whose outcome differs across the reruns of the same label is `flaky`. It's excluded from classification and listed in the report.
4. **Timeouts.** `per_command_seconds` kills the process tree. Tests absent from the XML after a timeout are `error: timeout`, and the remaining reruns of that label are skipped (they would hang the same way). A command-level timeout loses every result of the run, so a per-test timeout inside the runner is strongly preferred: commands may use `{per_test_seconds}` (e.g. `--timeout={per_test_seconds}` with pytest-timeout, `-timeout` for go test, `@Timeout` defaults for JUnit). The selftest fixtures ship a zero-dependency `conftest.py` that does this with `SIGALRM`. Found during the live selftest: blind tests of `sum_to` asserted the closed form for `n = 10**30`, which a loop implementation never finishes.

### 8.4 Repairable errors

These, and only these, feed repair:

- compile step failures (stderr);
- load errors: a file produced no testcases;
- testcase `<error>` entries whose type or message matches `repair_error_patterns`.

`repair_error_patterns` is configurable, with language-family defaults:

| Family | Default patterns |
|---|---|
| Python | `ImportError`, `ModuleNotFoundError`, `SyntaxError`, `NameError`, `fixture '.*' not found`, `TypeError: .*__init__\(\)` |
| JS/TS | `Cannot find module`, `SyntaxError`, `ReferenceError`, `is not a constructor`, `TS\d{4}` |
| JVM | `cannot find symbol`, `NoClassDefFoundError`, `ClassNotFoundException` |
| Go | `undefined:`, `cannot use`, `imported and not used` |
| Rust | `error\[E\d{4}\]` |

Always excluded: every `<failure>`, and any `<error>` not matching a pattern (for example, an exception raised by the code under test is behaviour, not setup).

**Which revision errors come from:**

| Mode | Revision |
|---|---|
| `bugfix` | fixed |
| `new` | current |
| `audit` | current |

**Redaction before rendering:**

- the leak redaction (§6);
- strip any line containing `expected`, `actual`, `assert`, `!=`, `==` followed by a literal;
- strip values printed after `got`;
- truncate to 4 KB per test file.

### 8.5 Classification

**bugfix** (per test; `F` = fixed, `B` = buggy; `error` counts as fail):

| F | B | label |
|---|---|---|
| pass | fail | `effective` |
| fail | pass | `misguided` |
| pass | pass | `neutral` |
| fail | fail | `broken` |

Queue for adjudication: `misguided` (against the fixed revision) and `broken` (against the fixed revision).

In every mode: a test whose outcome is `flaky` or `skipped` on any label gets that category; a test whose fixed/current outcome is a repairable error is `unrepairable` (dropped, not queued: repair rounds are over by the time you classify). A test missing from a label counts as a fail and is shown as `timeout`, `compile-error` or `missing`.

**new:**

- pass on current → `accepted`;
- fail → `disputed` (queued).
- With mutants: an accepted test that fails on a mutant kills it, and is additionally labelled `effective`.
- Report the kill rate per target.

**audit:**

- blind tests are labelled as in `new`;
- existing tests that pass while a blind test on the same target fails → the pair is queued, and the existing test is labelled `suspect-existing` if the verdict is `code-wrong`. Pairing is by unit name in the file, so it over-matches; after the code fix, the suspects that fail are the bad tests.
- an `--existing` path that no longer exists (the agent deleted a file whose only tests were bad) is skipped by `exec`.

**Verdict effects:**

| Verdict | Effect |
|---|---|
| `test-wrong` | Test marked `quarantined`; excluded from promote; protect-tests allows editing or deleting its file |
| `code-wrong` | Target marked `likely-bug`; blocks promote until the code is changed and `exec` re-run shows the test passing |
| `spec-ambiguous` | Blocks promote until an `override` or `spec edit` plus regeneration |

## 9. MCP server (`tcheck mcp`)

Stdio JSON-RPC (newline-delimited). `initialize` echoes the client's `protocolVersion` when it is one we know (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`), else the newest; Claude Code 2.1.282 connected with this. Declared inline in `.claude-plugin/plugin.json` under `mcpServers.tcheck`. There is no `.mcp.json`, so developing in this repo doesn't register it as a project server. Repo root per §3.

**Confirmed in a live Claude Code 2.1.282 session** (`claude -p --plugin-dir .`, stream-json init event and `TCHECK_DEBUG_LOG` traces):

- **VERIFY 1:** the server appears as `plugin:test-checker:tcheck`, and its tools as `mcp__plugin_test-checker_tcheck__submit_tests`, `mcp__plugin_test-checker_tcheck__save_spec` and `mcp__plugin_test-checker_tcheck__save_verdict`. These match the `tools:` lines in `agents/*.md` exactly, and the subagents register as `test-checker:tcheck-spec-extractor`, `test-checker:tcheck-blind-writer`, `test-checker:tcheck-repair` and `test-checker:tcheck-adjudicator`.
- **VERIFY 2:** the plugin MCP server process has `CLAUDE_PROJECT_DIR` set to the project root (and its cwd is the project root too).
- **VERIFY 3:** the PreToolUse hook input for a subagent launch has `tool_name: "Agent"` and `tool_input: {subagent_type: "test-checker:tcheck-blind-writer", prompt, description, run_in_background}`. The hook matcher `Agent|Task` covers it.

`TCHECK_DEBUG_LOG=<file>` makes hooks and the MCP server append their raw inputs and startup environment to that file, for re-checking these after harness upgrades.

| Tool | Input | Behaviour | Returns |
|---|---|---|---|
| `submit_tests` | `{payload_id, files:[{path, content}], notes?}` | Payload must exist, be role `writer` or `repair`, and be unconsumed. Paths are plain file names matching the pattern's shape (no `/`, no `..`). ≤ 20 files, ≤ 200 KB total. Stores under `generated/<run>/<target>/round-<n>/`, marks the payload consumed, and appends to the ledger. | `"Stored 3 test files for src-stats-py--mean (round 0)."` |
| `save_spec` | `{payload_id, raw_output}` | Payload role `spec`; behaves like `spec save` | `"Spec saved for <target>. Leak check: passed."`, or an error text that tells the agent what to fix |
| `save_verdict` | `{payload_id, raw_output}` | Payload role `adjudicate`; behaves like `adjudicate save` | `"Verdict recorded: code-wrong for <test>."` |

Tool descriptions must say these are for test-checker's internal roles only.

## 10. Ledger

`ledger.jsonl` holds one JSON object per line, `{ts, run?, type, …}`. Types:

- `initialized` (`init`)
- `run_started`
- `revision_refreshed` (a `WORKTREE` label re-snapshotted by `exec`)
- `target_added`
- `context_set`
- `spec_saved`
- `spec_edited`
- `bundle_frozen`
- `payload_emitted` (`role`, `sha256`; never the text)
- `tests_submitted`
- `exec_completed` (per label summary)
- `classified` (counts)
- `verdict`
- `override`
- `promoted` (files)
- `waived`
- `hook_blocked` (event, reason)
- `run_reported`

**`state.json`:**

```json
{
  "verified": { "src/stats.py": { "sha": "<git blob sha>", "run": "r-…", "at": "…" } },
  "protected": { "tests/regression/test_mean_1.py": { "test_ids": ["…"], "run": "r-…" } },
  "quarantined": ["<test id>"],
  "hooks_seen_at": "2026-09-25T20:15:00Z"
}
```

**Dirty files.** A file is dirty when:

- it matches `source_globs`;
- it's modified or untracked per `git status --porcelain`, or differs from `HEAD`;
- its current blob sha ≠ `verified[path].sha`.

Files committed without verification stop being dirty. That's accepted in v1 and documented.

## 11. Blind backends (`blind-run`)

Each backend receives the rendered payload with `submit_via_text` and returns text. The engine then runs `ingest`.

Confirmed flags (VERIFY 4), checked against claude 2.1.282, codex-cli 0.147.0, opencode 1.15.13 and pi 0.84.1:

| Backend | Invocation | Isolation | Live status |
|---|---|---|---|
| `api` (opt-in only) | HTTPS POST: Anthropic Messages API (`anthropic-version: 2023-06-01`) or OpenAI Responses API; no tools; `blind.api.model`; key from `blind.api.key_env`. For users who have a key. Never a default. | strong | not exercised (no key, by design) |
| `claude` | `claude -p --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources "" --disable-slash-commands --no-session-persistence --output-format text [--model M]`, prompt on stdin. `--bare` would also skip CLAUDE.md auto-discovery but forces API-key auth, so it breaks subscription login and is not used. | medium to strong (user CLAUDE.md is still loaded; no tools, so nothing can be read) | confirmed on a subscription login |
| `codex` | `codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never -C <tmpdir> -o <file> [-m M] -`, prompt on stdin, answer read from the `-o` file | medium | flags accepted; the run on this machine was refused because the configured model needs a newer Codex CLI |
| `opencode` | `opencode run --agent tcheck-blind-writer --dir <tmpdir> [-m M] "<prompt>"`, with a temp `opencode.json` in `<tmpdir>` defining that agent with every permission `deny` and `tools: {"*": false}` | strong | flags accepted; no usable provider on this machine (OpenCode's free tier refuses headless use) |
| `pi` | `pi -p --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --no-session --offline [--model M] "<prompt>"` | strong (no tools, no context files) | confirmed |

Harness session variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `PLUGIN_ROOT`, `CODEX_THREAD_ID`, …) are stripped from the child environment so a nested CLI doesn't think it runs inside the caller's session.

**Temp dir.** `<tmpdir>` is created under the OS temp root, never inside the repo, and contains only `PROMPT.md` (plus the agent-only `opencode.json` for that backend). It's deleted afterwards. The prompt never includes the repo path.

**Backend `auto`:**

| Harness | Backend |
|---|---|
| `claude-code`, `cowork` | `native` (the skill uses subagents; `blind-run` refuses and says so) |
| `opencode` | `native` |
| `pi` | `native` (extension tools) |
| `codex` | `codex` |
| `unknown` | The first installed CLI among `claude`, `codex`, `opencode`, `pi` (each uses its own subscription login), else `api` if a key is present, else `none` |

## 12. Report

`reports/<run>.md` sections, in order:

1. Header: run id, mode, revisions, date, harness, blind isolation level.
2. Summary table per target: effective / misguided / neutral / broken (or accepted / disputed), flaky, dropped, mutant kill rate.
3. **Likely bugs:** `code-wrong` verdicts, each with the spec basis, the failing test name and the failure summary.
4. **Suspicions:** the spec-extractor `<analysis>` items, per target.
5. **Needs your decision:** `spec-ambiguous` items, each with the question.
6. **Misguided tests and what happened to them.**
7. **Dropped:** flaky, unrepairable after N rounds, quarantined.
8. **Promotable tests,** with the target paths `promote` would write.

`reports/<run>.json` holds the same content as structured data. The console summary is at most 10 lines.

## 13. Hooks

`tcheck hook <event>` reads the harness's stdin JSON and normalises it to:

```ts
{ event, tool?: string, input?: object, subagent?: string, agentType?: string, stopHookActive?: boolean, cwd }
```

It evaluates the event, then writes the harness-specific response. The library exports `evaluateHook(normalizedEvent): Decision` for the OpenCode and Pi integrations:

```ts
type Decision =
  | { action: "allow" }
  | { action: "deny"; reason: string }          // PreToolUse
  | { action: "block"; reason: string }         // Stop
  | { action: "warn"; message: string }         // Stop in warn mode
  | { action: "context"; text: string };        // SessionStart
```

Every hook records `hooks_seen_at`, and must finish in < 300 ms in the common path. If there's no config in the repo, return `allow` / no output immediately.

| Event | Logic |
|---|---|
| `session-start` | Config present → `context`: `"test-checker is active (gate: <mode>). <n> source file(s) changed since last verification. Use the test-checker skill before finishing work on them."` Omit the second sentence when n = 0. |
| `handoff-guard` | Only if `tool_input.subagent_type` ∈ {`test-checker:tcheck-blind-writer`, `test-checker:tcheck-repair`} (or OpenCode names). Allow iff `tool_input.prompt.trim()` equals a registered, unconsumed payload file's text of the matching role. Otherwise deny: `"Blind roles must receive the exact output of \`tcheck bundle emit\`. Re-emit and pass it verbatim."` |
| `protect-tests` | Collect target paths from `file_path`, `notebook_path`, or apply_patch text (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`). Deny if any path is protected (`state.protected`, `protect` globs, `.test-checker/generated/**`) and not quarantined, not overridden, and `TCHECK_ALLOW_TEST_EDITS` isn't `1`. Reason names the test and says how to proceed (adjudicate, or ask the user). |
| `stop-gate` | `gate: off` → allow. Compute dirty files (§10). None → allow. `warn` → `warn`, listing files. `block` → `block` unless `stop_hook_active` is true (then `warn`, to avoid loops). Reason: `"<n> changed source file(s) are unverified: … Run the test-checker skill, or ask the user to waive."` |

**Output mapping:**

| Harness | deny | block | warn | context |
|---|---|---|---|---|
| Claude Code | stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":R}}`, exit 0 | `{"decision":"block","reason":R}` | `{"systemMessage":M}` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":T}}` |
| Codex | Same JSON. Per the Codex hooks docs (VERIFY 6, docs-confirmed, not yet live): PreToolUse honours `permissionDecision: deny` (and legacy `decision: block`), and `systemMessage` / `additionalContext` are honoured inside `hookSpecificOutput`. File edits arrive as `tool_name: "apply_patch"` with `tool_input: {"command": "<patch>"}`; protect-tests reads the `*** … File:` headers from any string in the input. | | | |
| OpenCode | the integration throws an Error with the reason from `tool.execute.before` | the integration injects a follow-up message | toast/log | system prompt addition |
| Pi | the `tool_call` handler returns its block result | the `agent_end` handler queues a follow-up user message | notify | `before_agent_start` system prompt addition |

**Failure mode.** On an internal error, a hook must **allow** (exit 0), write a stderr note, and never break the user's session. The exception is `handoff-guard`, which denies on internal error: it protects blindness, and a failed launch is harmless.

## 14. Selftest

`fixtures/` layout and cases are in `docs/fixtures-spec.md`. `tcheck selftest` does the following:

1. For each fixture, build a temp git repo from its `buggy/` and `fixed/` trees (two commits).
2. Run `bugfix` mode with `spec.source: buggy` (the paper's setting). The blind roles use a headless backend (`--backend`; default: the first installed of `claude`, `codex`, `opencode`, `pi`, all running on the user's subscription login; `api` only if explicitly chosen).
3. Run a **baseline** with `code-aware-baseline.md` through the same backend.
4. Print a table: fixture × {blind, baseline} × {effective, misguided, broken, neutral}, plus pass/fail against the criteria in `fixtures-spec.md`.

It must not require any harness session. The model calls go through the backend. Fixtures run in parallel; within a fixture the blind and baseline runs are sequential (they share cached worktrees). The spec role gets one retry if its output quotes the body or misses the format.

`--with-intent` passes each fixture's `intent` to the spec prompt as the developer's stated intent (like `spec prompt --intent`). The default is the paper's setting, with no stated intent.

**First live result** (claude backend, paper setting, 2026-09-25):

| fixture | blind eff / mis / broken / neutral | baseline eff / mis / broken / neutral |
|---|---|---|
| off_by_one | 13 / 0 / 4 / 20 | 0 / 7 / 0 / 7 |
| stale_state | 9 / 0 / 0 / 8 | 0 / 1 / 0 / 7 |
| wrong_operator | 8 / 0 / 17 / 13 | 8 / 0 / 0 / 6 |
| boundary | 0 / 7 / 3 / 34 | 0 / 5 / 0 / 10 |
| null_guard | 0 / 9 / 47 / 20 | 0 / 3 / 0 / 19 |

Criteria 1 and 4 passed everywhere; criterion 2 failed on `boundary` and `null_guard`; criterion 3 warned (16 vs 16). Both failures are the paper's known misguidance channel, not engine faults. With the spec derived from the buggy code and no stated intent, the extractor adopted the bug as the convention: a half-open `[lo, hi)` for `in_range`, and `""` for blank names in `normalize_name`. The blind tests then enshrined it. It also over-specified "robustness" (name particles, Roman numerals, `TypeError`s), which shows up as broken tests for adjudication.

## 15. OpenCode and Pi integrations (thin code, built with the engine)

**`.opencode/plugins/test-checker.mjs`** imports `../../dist/tcheck.mjs` and does the following:

- **`config` hook:**
  - adds `skills` path `../../skills`;
  - registers the four agents from `agents/*.md` (body only) as `mode: "subagent"`, `hidden: true`, with every built-in permission `deny`, and allows only the matching plugin tool.
- **Tools:** registers `tcheck_submit_tests`, `tcheck_save_spec` and `tcheck_save_verdict`, backed by the same functions as the MCP tools (`callTool`). OpenCode tool args must be Zod schemas; the package ships no dependencies, so the plugin resolves Zod at runtime from `@opencode-ai/plugin` (or `zod`) and, if neither resolves, logs that the role tools are unavailable and the skill falls back to `tcheck blind-run`.
- **`shell.env`:** sets `TCHECK_HARNESS=opencode`.
- **`tool.execute.before`:** handoff-guard (on `task`, reading `args.subagent_type` / `args.prompt`) and protect-tests (on `edit`, `write`, `patch`, `multiedit`); a deny throws an Error with the reason.
- **End of turn:** the `event` hook on `session.idle` runs stop-gate. A `block` sends one follow-up prompt through `client.session.prompt`; while the files stay dirty, later idles only toast (loop guard).
- **Session start:** context via `experimental.chat.system.transform` (`output.system.push`).

Hook shapes were checked against `@opencode-ai/plugin` 1.15.13 type definitions (VERIFY 8, typed but not yet exercised in a live OpenCode session with a working provider).

**`pi-extension/index.mjs`** does the following:

- sets `process.env.TCHECK_HARNESS = "pi"`;
- registers the tools `tcheck_spec {run, target, intent?}`, `tcheck_blind_generate {bundle_id, run?}`, `tcheck_blind_repair {bundle_id, run?}` and `tcheck_adjudicate {run, test_id}`. Each renders its payload, calls the model with **no tools**, and saves the result via the engine. VERIFY 9 (confirmed against pi 0.84 docs and `examples/extensions/summarize.ts`): `ctx.modelRegistry.complete(model, {messages})` is the extension-accessible tool-less completion. The model is `blind.model` (`provider/id`) if set, else `ctx.model`; fallback: the `pi` headless backend. Live-checked: pi 0.84.1 loads the extension and lists all four tools;
- `tool_call`: protect-tests on `edit` / `write` (returns `{block: true, reason}`);
- `agent_end`: stop-gate; a `block` queues one `sendUserMessage(reason, {deliverAs: "followUp"})`, then only notifies while files stay dirty;
- `before_agent_start`: session context appended to `event.systemPrompt`.

## Open items

Status of every **VERIFY** item and of known gaps after the first build (2026-09-25). "Docs-confirmed" means checked against the harness's published docs or type definitions but not yet exercised live.

| Item | Status |
|---|---|
| VERIFY 1: plugin MCP tool names | **Confirmed live** (Claude Code 2.1.282), §9. |
| VERIFY 2: `CLAUDE_PROJECT_DIR` for the plugin MCP server | **Confirmed live**, §9. |
| VERIFY 3: `subagent_type` in the Agent PreToolUse input | **Confirmed live**, §9. |
| VERIFY 4: headless flags for `claude -p` and `codex exec` | **Confirmed** for `claude` and `pi` (live). `codex` flags accepted, but the live run was blocked by the local Codex CLI being too old for its configured model. `opencode` flags accepted, but no headless-capable provider was configured. §11. |
| VERIFY 5: `${CLAUDE_PLUGIN_ROOT}` in Codex hook commands | Docs-confirmed: Codex sets `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` as env vars and the shell expands them (POSIX). Open: a live Codex session, and Windows (`cmd` does not expand `${…}`). |
| VERIFY 6: Codex edit tool name and output fields | Docs-confirmed (`apply_patch` with `{command}`, `permissionDecision`, `systemMessage`, `additionalContext`), §13. Open: live check. |
| VERIFY 7: Codex detection env vars for shell-tool processes | **Open.** Heuristic: `PLUGIN_ROOT` or any `CODEX_*` (not `CODEX_HOME`). `TCHECK_HARNESS=codex` overrides. |
| VERIFY 8: OpenCode end-of-turn event and single-tool agents | Typed against `@opencode-ai/plugin` 1.15.13 (`session.idle` via `event`, `tools: {"*": false, <tool>: true}`, permissions `deny`). Open: a live OpenCode session. Also open: whether `config.skills.paths` is the key OpenCode reads, and whether plugins can import `@opencode-ai/plugin`/`zod`. |
| VERIFY 9: Pi tool-less model call | **Confirmed** from the pi 0.84 docs (`ctx.modelRegistry.complete`). The extension loads live in pi 0.84.1 and registers its four tools; an end-to-end Pi loop has not been run. |
| Cowork marker (§4) | Open. |
| Windows | Untested. Paths use `node:path` and commands go through `cmd /c`, but the `opencode`/`pi` backends pass the prompt as an argument, which `shell: true` on Windows does not quote. |
| Worktree cache growth | Cached worktrees are never pruned automatically (§8.1). |
| Selftest criterion 2 in the paper setting | Fails on `boundary` and `null_guard` (§14); `--with-intent` has not been run yet. |
