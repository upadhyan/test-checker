# test-checker — Plugin Design

> **Status:** the manifests, skills, agents, prompts and schemas described here now exist in the repo. For exact command, hook and MCP behaviour, **`docs/engine-spec.md` is authoritative**. This doc explains the reasoning.

A cross-harness plugin that makes a coding agent verify its unit tests using the dual-execution / blind-specification procedure from Zhao, Zhou & Cohen ([arXiv:2607.22883](https://arxiv.org/abs/2607.22883)). See [`test-verification-procedure.md`](./test-verification-procedure.md) for the paper's procedure.

**Constraints**

- **Language-agnostic.** Nothing in the core assumes a language, test framework or build tool.
- **Works in each harness, not identically in each.** First-class in Claude Code and Cowork; installable in Codex, OpenCode and Pi. Each harness gets its own install and pathway wherever that's what makes the loop correct. Correctness, especially blindness, beats uniformity.
- **Pragmatic validation.** A handful of small bug/fix fixtures (Python to start) to sanity-check the loop. No formal verification, no Defects4J harness.

---

## 1. Design principle: shared core, native pathway per harness

Every harness supports some of skills, subagents, hooks and plugins, but in different shapes. So the deterministic logic lives in a **shared core**: the `tcheck` CLI engine, plain-text prompts, the bundle schema and the ledger.

Each harness then gets a **native pathway**: its own install command and manifest (all in one repo, §7), its own way of isolating the blind writer (§4), and its own hook wiring. Pathways share prompts and engine but are otherwise free to differ.

```
┌────────────────────────── shared core ───────────────────────────┐
│ tcheck engine · prompts · bundle schema · ledger · skill source   │
└──────▲──────────────▲───────────────▲───────────────▲────────────┘
       │              │               │               │
 Claude Code/Cowork   OpenCode        Pi              Codex
 1-tool subagent      deny-all agent  extension tool  codex exec / api
 + hooks.json         + plugin.ts     raw model call  + hooks.json
```

A generic fallback (portable skill + CLI + headless spawning) still covers harnesses with no dedicated pathway. You lose only automatic enforcement (hooks).

---

## 2. Harness capability matrix

Researched September 2026. Re-check before building; these surfaces change monthly.

| Capability | Claude Code / Cowork | Codex | OpenCode | Pi |
|---|---|---|---|---|
| Agent Skills (`SKILL.md`) | Yes (`skills/`, `.claude/skills/`) | Yes (`.agents/skills/`) | Yes (reads `.opencode/`, `.claude/`, `.agents/skills/`) | Yes (SKILL.md standard) |
| Subagents | `agents/*.md`, per-agent tool allowlist | `.codex/agents/*.toml`: `sandbox_mode`, MCP bindings; no per-tool allowlist | `.opencode/agents/*.md`, `mode: subagent`, `permission` deny per tool | None native; build one in an extension or spawn `pi` |
| Hooks | `hooks.json`: PreToolUse, PostToolUse, Stop, SubagentStop, … | `hooks.json` (same model): PreToolUse, PostToolUse, Stop, SubagentStop; block via exit 2 or `decision: block` | JS/TS plugin: `tool.execute.before/after`, `file.edited`, session events; can block | TS extension: `tool_call` (can block), `tool_result`, `agent_end`, … |
| Plugin packaging | `.claude-plugin/plugin.json` + marketplace | Root `plugin.json` (Agent Plugins) or `.codex-plugin/plugin.json`; hooks via `hooks/hooks.json` | npm package in `opencode.json` or `.opencode/plugins/` | `pi install npm:…` / `git:…` packages |
| Headless mode | `claude -p` | `codex exec` | `opencode run` | `pi -p` |

**Implications**

1. **Skills are the common denominator.** The orchestrator must be a skill.
2. **Blindness needs a different mechanism per harness.** Claude Code and OpenCode can define subagents limited to a single tool (Claude Code refuses to launch one with zero tools). Codex can't strip file tools per agent. Pi has no subagents but can make a raw model call from an extension. §4 picks the strongest mechanism for each.
3. **Hooks exist everywhere but in two shapes.** There is a JSON-config shape (Claude Code, Codex) and a code-plugin shape (OpenCode, Pi). Both call the same `tcheck hook …` entry point.
4. **Every CLI harness has a headless mode.** This is the fallback for blind workers where no native mechanism is good enough. Cowork may not expose a `claude` CLI inside its sandbox, so Cowork must use native subagents.

**To verify:** whether Cowork runs plugin hooks the same way Claude Code does. Skills and agents port; hooks are unconfirmed.

---

## 3. Language-agnostic by configuration

The core never parses test output or build files itself. Each repo declares how to do things in `.test-checker/config.yaml`:

```yaml
language: python            # informational only
source_globs: ["src/**"]
test_dir: tests/tcheck             # final path inside the project; tests only land there in worktrees until `promote`
test_file_pattern: "test_{method}_{id}.py"

commands:
  # {files} = generated test files, {junit} = path to write JUnit XML
  run: "pytest {files} --junitxml={junit} -p no:cacheprovider"
  compile: null             # e.g. "mvn -q test-compile" or "tsc --noEmit"
  mutate: null              # optional, e.g. "mutmut run --paths-to-mutate {file}"

results:
  format: junit-xml         # lingua franca: pytest, jest-junit, surefire,
                            # go-junit-report, cargo-nextest, dotnet all emit it
flake_reruns: 3
```

- **JUnit XML is the interchange format.** Almost every test runner in every language can emit it, so the classifier reads one format.
- **`tcheck init`** asks the agent to fill this config by inspecting the repo (it can see build files), then dry-runs the `run` command once.
- **Context extraction is agent-driven, engine-validated.** The orchestrating agent (which can see the code) assembles the context bundle against a JSON schema. The engine then checks that the focal method body is not in it (line-range and fuzzy-substring check). Optional tree-sitter support later can auto-extract signatures for common languages, but it isn't required.

**Context bundle schema** (what the blind worker sees):

```json
{
  "focal": { "name": "...", "signature": "...", "file": "...", "language": "..." },
  "spec": "docstring from spec-extractor",
  "class_context": { "constructors": [], "fields": [], "sibling_signatures": [] },
  "type_context": [ { "name": "...", "constructors": [] } ],
  "test_conventions": { "framework": "pytest", "imports": [], "example_test": "..." }
}
```

It deliberately has no `body` field.

---

## 4. Blindness: how it's enforced

The blind test writer must never see the implementation. Two rules apply in every harness; how they are enforced differs by pathway.

**Rule 1: the blind input is a validated file, never free text.** The orchestrating agent has read the code. If it writes the blind worker's prompt by hand, it can leak the body by paraphrasing. So:

1. `tcheck bundle validate` checks the bundle for leaks of the method body.
2. The engine then freezes it as `.test-checker/bundles/<id>.json` and records its hash.
3. The blind worker receives exactly that file's contents, plus the fixed `prompts/blind-write.md`.

Wherever possible the file is loaded by code (the engine or an extension), not retyped by the agent.

**Rule 2: the blind worker can't read anything.** Its only tool, if it has one, is write-only. In Claude Code and OpenCode that's `submit_tests`, backed by the engine, because Claude Code refuses to launch zero-tool subagents. Elsewhere it has no tools and returns text. Either way, the engine writes the files.

The same **payload-in, tool-out** pattern applies to every role: the spec-extractor and adjudicator also receive engine-rendered payloads and save through `save_spec` / `save_verdict`. So the orchestrating agent never retypes a role's input or output.

### Per-harness pathway

| Harness | Blind-worker mechanism | How Rule 1 is enforced | Strength |
|---|---|---|---|
| **Claude Code** | Native subagent `tcheck-blind-writer`; only tool: `submit_tests` (MCP). If the MCP server isn't running, the launch is refused, so it fails closed. | PreToolUse hook on the subagent-launch tool: allows the call only if the prompt matches a frozen bundle hash | Strong |
| **Cowork** | Same plugin and subagent as Claude Code. Native is required: a `claude` CLI likely isn't available inside Cowork's sandbox. | Same hook if Cowork runs plugin hooks (to verify). Otherwise the skill pastes `tcheck bundle emit <id>` output verbatim and the engine re-checks the hash when tests come back. | Strong / medium |
| **OpenCode** | Native agent `.opencode/agents/tcheck-blind.md`: `mode: subagent`, `hidden: true`, every permission `deny` | TS plugin `tool.execute.before` on the `task` tool checks the bundle hash | Strong |
| **Pi** | Extension registers a `tcheck_blind_generate` tool that makes a raw model call through Pi's provider layer, with no tools | The extension reads the bundle file itself; the agent passes only the bundle id | Strongest: the model never composes the input |
| **Codex** | `tcheck blind-run --backend codex` spawns `codex exec` in an empty temp dir outside the repo, `--sandbox read-only` | The engine reads the bundle file; the agent passes only the id | Medium: a read-only sandbox can still read absolute paths. Opt-in `--backend api` (for users with a key) or a container makes it strong. |
| **Generic fallback** | `tcheck blind-run --backend <cli>` headless spawn in a temp dir, tools disabled | Engine reads the bundle file | Medium, depends on the CLI's tool controls |

Exact flags, frontmatter syntax for an empty tool list, and hook input fields for the subagent-launch tool are confirmed when each pathway is built.

### Other isolated roles

| Role | Sees | Must not see | Mechanism |
|---|---|---|---|
| spec-extractor | code + context | — | Native subagent where available, else in-session |
| blind-test-writer | frozen bundle | focal body, existing tests | Per-harness pathway above |
| repair-agent | frozen bundle + filtered compile/setup errors | assertion failures, runtime values, body | Same pathway as the blind writer |
| adjudicator | spec, test, failure, code | — | Native subagent where available, else in-session |

The repair agent is fed compile/setup errors only. The paper shows that runtime feedback from buggy code drags tests toward the bug. The engine filters errors by category before handing them over.

---

## 5. The loop

The orchestrator skill drives this; the engine does each deterministic step.

```
1  scope      tcheck scope            → changed/target methods (git diff or user list)
2  config     tcheck init (once)      → .test-checker/config.yaml
3  spec       spec-extractor          → spec per method (advanced docstring prompt)
4  bundle     agent builds bundle     → tcheck bundle validate (body-leak check)
5  generate   tcheck blind-run        → raw tests from blind worker
6  compose    tcheck compose          → test files in test_dir
7  repair     tcheck repair (≤3 rds)  → fix compile/setup errors only, blind
8  execute    tcheck run --mode …     → JUnit XML per revision, flake reruns
9  classify   tcheck classify         → four-way labels + ledger entry
10 adjudicate adjudicator             → for failures: test-wrong | code-wrong | spec-ambiguous
11 report     tcheck report           → .test-checker/reports/<run>.md + JSON
```

### Modes: what stands in for the fixed version

| Mode | Buggy side | Fixed side | Output |
|---|---|---|---|
| `bugfix` | `git worktree` at the pre-fix rev | working tree / post-fix rev | The paper's exact four-way table (effective / misguided / TN / FP) |
| `new` | mutants of the current code (if `mutate` configured) | current code | Tests passing on current code and killing mutants = effective. Blind tests failing on current code → adjudication. |
| `audit` | — | current code | Blind suite vs. existing suite; tests where they disagree get flagged for review |

### Adjudication outcomes

- **test-wrong:** the test is quarantined with a reason in the ledger. The protect-tests hook then allows the agent to delete or rewrite it.
- **code-wrong:** reported as a likely bug. The agent is told to fix the code, not the test.
- **spec-ambiguous:** escalated to the user with the spec line in question. The Stop gate stays closed until the user answers or overrides.

---

## 6. Hooks: what they enforce

All hook logic lives in `tcheck hook <event>`. It reads the harness's JSON on stdin, normalises it, and returns allow/block in the harness's expected shape (`--format claude|codex|opencode|pi`).

| Guard | Event (CC / Codex · OpenCode · Pi) | Behaviour |
|---|---|---|
| **protect-verified-tests** | PreToolUse on Edit/Write · `tool.execute.before` · `tool_call` | Blocks edits to files under `test_dir` unless the ledger marks that test `test-wrong` or the user overrode. Stops "make the test pass by changing the assertion." |
| **stop-gate** | Stop · `session.idle` · `agent_end` | Dirty files are computed from `git status` against the verified snapshot, so no edit tracking is needed and edits made through the shell count too. If dirty methods have no current report, or have unresolved misguided/FP/ambiguous tests, blocks with a message telling the agent to run `/test-checker`. Has a bypass (`TCHECK_GATE=off` or a ledger override) so it can't trap you. |
| **bundle-handoff guard** | PreToolUse on the subagent-launch tool · `tool.execute.before` on `task` | Allows a blind-writer or repair launch only if its prompt is a frozen bundle (hash match). Enforces Rule 1 in Claude Code and OpenCode. Not needed in Pi or Codex, where code loads the bundle. |

The OpenCode and Pi event names above come from their docs. Confirm the exact end-of-turn event when building each pathway.

The stop-gate should be opt-in per repo (`gate: true` in config). Otherwise it fires in every session after any edit.

---

## 7. Repository layout: one repo, every harness's native install

This follows the [ponytail](https://github.com/DietrichGebert/ponytail) model. The GitHub repo **is** the plugin and the marketplace for every harness. Each harness's own install command points at the repo, and there's no separate installer, download step or build on the user's machine.

| Harness | Install |
|---|---|
| Claude Code | `/plugin marketplace add <you>/test-checker` → `/plugin install test-checker@test-checker` |
| Cowork | Same Claude marketplace |
| Codex | `codex plugin marketplace add <you>/test-checker` → `codex plugin add test-checker@test-checker` |
| OpenCode | `{ "plugin": ["@<you>/test-checker"] }` in `opencode.json` (npm package from the same repo) |
| Pi | `pi install git:github.com/<you>/test-checker` |
| Anything else | Copy `skills/test-checker/` into the harness's skills dir; CLI via `node dist/tcheck.mjs` |

Per-harness manifests sit side by side at the repo root:

```
test-checker/
├── .claude-plugin/
│   ├── plugin.json                # Claude Code / Cowork manifest (hooks file + inline tcheck MCP server)
│   └── marketplace.json           # Claude marketplace: one plugin, source "./"
├── .codex-plugin/plugin.json      # Codex manifest (skills, hooks, interface)
├── .agents/plugins/marketplace.json   # Codex marketplace entry (git URL source)
├── plugin.json                    # portable Agent Plugins manifest
├── package.json                   # npm package: OpenCode "main", Pi "pi" key, tcheck bin
├── opencode.json                  # dev-time OpenCode pointer to the local plugin
│
├── dist/tcheck.mjs                # the engine: ONE bundled file, committed   [code]
├── src/                           # engine TypeScript source                 [code]
├── prompts/                       # every model-facing instruction (single source)
├── skills/
│   ├── test-checker/SKILL.md      # the loop, harness-neutral
│   │   └── references/
│   │       ├── harness/{claude-code,codex,opencode,pi,generic}.md
│   │       ├── modes.md, config-reference.md
│   │       └── bundle.schema.json, config.schema.json
│   └── test-checker-setup/SKILL.md
├── agents/                        # role cards (Claude Code reads them; OpenCode plugin reuses bodies)
│   └── tcheck-{spec-extractor,blind-writer,repair,adjudicator}.md
├── hooks/claude-codex-hooks.json  # → node dist/tcheck.mjs hook <event>
│                                  # (non-default name so neither harness double-loads it)
├── .opencode/plugins/test-checker.mjs   # OpenCode integration   [code]
├── pi-extension/index.mjs         # Pi integration               [code]
├── examples/config.{python,typescript,go,java,rust}.yaml
├── fixtures/                      # selftest cases per docs/fixtures-spec.md   [code]
├── docs/ plugin-design.md, engine-spec.md, fixtures-spec.md, test-verification-procedure.md
├── CONTRIBUTING.md
└── README.md
```

**Rules that make "plugin install and it works" hold**

1. **Nothing needs installing after clone.** Plugin installs just fetch the repo; they don't run `npm install`. So the engine is bundled (esbuild) into a single `dist/tcheck.mjs` with every dependency inlined, and that file is committed. CI checks that `dist/` matches `src/`.
2. **No native modules.** They'd need compiling per platform. If tree-sitter is added later, use the WASM build (`web-tree-sitter`), inlined or shipped as `.wasm` in the repo.
3. **Config is YAML or JSON, parsed by the bundled engine.** No external parser at runtime.
4. **Hooks locate the engine by plugin-root env var** (`${CLAUDE_PLUGIN_ROOT}` in Claude Code, `PLUGIN_ROOT` in Codex, the package directory in OpenCode and Pi). No global install and nothing on `PATH` except `node`.
5. **One skill for all harnesses.** `SKILL.md` stays harness-neutral. It tells the agent to run `node <root>/dist/tcheck.mjs env` once. That command detects the harness from env vars and prints which `references/harness/<harness>.md` to follow for the blind step. So each harness gets its own blind mechanism (§4) without separate skill copies.

**Open to verify during build:**

- whether a Codex plugin can bundle custom agents (not needed: Codex's blind step uses `codex exec`);
- whether OpenCode's plugin API can register agents directly, or whether the plugin writes `.opencode/agents/` on first run.

---

## 8. Runtime: Node, as ponytail does

**Decision: TypeScript source, shipped as bundled JavaScript run by `node`.** Users need only `node` on `PATH`, the same requirement ponytail states for its Claude Code and Codex hooks.

- **OpenCode and Pi** already run JS, so their plugins import `dist/tcheck.mjs` directly. Pi's blind tool runs in-process.
- **Claude Code, Cowork and Codex** hooks call `node "$PLUGIN_ROOT/dist/tcheck.mjs" hook <event>`. Node starts fast enough for per-tool-call hooks.
- **Cost:** users without Node must install it once. The README says so up front. A compiled standalone binary would remove that requirement, but it breaks "plugin install and done": plugin installs can't pick a per-platform binary. So it isn't used.
- **Cowork:** confirm that `node` is available inside Cowork's sandbox. If not, the Claude hooks degrade gracefully (skip enforcement, warn once) and the skill still runs.

---

## 9. Sanity-check fixtures (not formal verification)

`fixtures/` holds 5–6 tiny bug/fix pairs as git repos. The first batch is in Python only because it's quick to write:

| Fixture | Bug |
|---|---|
| `off_by_one` | `range(n)` vs `range(n+1)` in a sum |
| `boundary` | `<` vs `<=` in a clamp |
| `null_guard` | missing `None` check |
| `wrong_operator` | `and` vs `or` in a validator |
| `stale_state` | field not reset between calls |

`tcheck selftest` runs `bugfix` mode on each, twice: once code-aware (the baseline) and once blind. Pass criteria:

- the pipeline completes end to end;
- the blind run produces at least one effective test on most fixtures;
- the blind run produces fewer misguided tests than the code-aware run.

Add one non-Python fixture (e.g. JS or Go) later to confirm the config-driven path works.

---

## 10. Build order

1. **Engine skeleton:** `init`, `env`, `bundle validate/freeze/emit`, `compose`, `run` (JUnit parsing, `git worktree` dual-rev), `classify`, `report`, ledger. esbuild bundles it to the committed `dist/tcheck.mjs`, and CI checks the bundle is fresh.
2. **Shared prompts + skill,** `bugfix` mode only.
3. **Claude Code pathway:** MCP tools, agents, hooks including the bundle-handoff guard. Run fixtures.
4. **Cowork check:** install the same plugin, and confirm subagents and hooks behave.
5. **Adjudicator + `new` mode** (mutation optional).
6. **Pi pathway:** extension with raw-call blind tool + guards.
7. **OpenCode pathway:** plugin.ts + deny-all subagents.
8. **Codex pathway:** `codex`/`api` backends, hooks.json, TOML agents.
9. **`audit` mode + non-Python fixture.**

---

## 11. Open decisions

- **Codex strict mode:** medium-strength `codex exec` isolation is the default, since it runs on the user's subscription. The `api` backend stays opt-in for users with a key.
- **Mutation testing in v1,** or defer `new`-mode mutants and rely on adjudication only.
- **Stop-gate default:** opt-in per repo (recommended) vs on by default.
- **Scope per run:** changed methods only (recommended) vs whole files. This drives cost: roughly 3–4 model calls per method plus repair rounds.

---

## Sources

- Install model: [ponytail](https://github.com/DietrichGebert/ponytail) (per-harness manifests in one repo, Node hooks).
- Claude Code / Cowork plugin, skill, agent and hook formats: Anthropic docs.
- Codex: [hooks](https://learn.chatgpt.com/docs/hooks), [plugin packaging](https://developers.openai.com/codex/plugins/build), [custom agents (TOML)](https://codex.danielvaughan.com/2026/04/27/codex-cli-custom-agent-definitions-toml-specialised-subagents/)
- OpenCode: [plugins](https://opencode.ai/docs/plugins/), [agents](https://opencode.ai/docs/agents/), [skills](https://opencode.ai/docs/skills/)
- Pi: [overview](https://pi.dev/), [extensions](https://pi.dev/docs/latest/extensions)
