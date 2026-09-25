# `.test-checker/config.yaml` reference

The config lives in the **target** repo and should be committed. `tcheck init` writes a starting version; `tcheck doctor` checks it. The JSON Schema is `config.schema.json`, next to this file. The `examples/` folder at the plugin root has configs for Python, TypeScript, Go, Java and Rust.

```yaml
version: 1
language: python                  # used in prompts and code fences; free text
language_tag: python              # code-fence tag (defaults to language)
framework: pytest                 # used in prompts; free text

source_globs: ["src/**/*.py"]     # what counts as "source" for scope and the stop gate
test_dir: tests/tcheck            # where generated tests go (inside the project, so imports work)
test_file_pattern: "test_{symbol}_{n}.py"
# Path placeholders (test_dir, test_file_pattern, promote_dir):
#   {symbol} target symbol, lowercase snake    {Symbol} PascalCase
#   {target_slug} file+symbol slug             {n} test file index
#   {pkg_dir} directory of the target file     {package_path} language package path (Java/Kotlin)
promote_dir: tests/regression     # where `tcheck promote` copies accepted tests

commands:                         # run from the repo (or worktree) root
  # Placeholders: {files} space-separated generated test paths,
  #               {junit} path the runner must write JUnit XML to (a file, or a directory of
  #                       XML files; the engine accepts both),
  #               {test_dir}, {root}
  setup: null                     # optional, run once per worktree (e.g. "npm ci")
  compile: null                   # optional compile or type-check step
  run: "python -m pytest {files} --junitxml={junit} -q -p no:cacheprovider"
  mutate: null                    # optional; see "mutation" below

results:
  format: junit-xml               # only supported format in v1

timeouts:
  per_test_seconds: 30            # enforced via the runner where possible, else per command
  per_command_seconds: 600

flake_reruns: 3                   # each revision is run this many times; inconsistent tests are dropped
refine_rounds: 3                  # max repair rounds

spec:
  prompt: advanced                # advanced | base
  variant: auto                   # auto | reasoning | scaffold (auto picks by harness/model)
  source: fixed                   # bugfix mode: derive the spec from fixed (default) or buggy code

blind:
  backend: auto                   # auto | native | api | claude | codex | opencode | pi
  model: null                     # optional model override for the blind roles
  api:                            # OPT-IN ONLY: direct API calls for users who have a key
    provider: anthropic           # anthropic | openai
    model: null                   # required when backend: api
    key_env: ANTHROPIC_API_KEY

gate: warn                        # off | warn | block (stop-gate behaviour)
protect:                          # globs that protect-tests guards (test_dir and promote_dir are always included)
  - tests/regression/**

leak:                             # body-leak detection (engine-spec §6)
  shingle_threshold: 0.25
  min_line_length: 12

repair_error_patterns: null       # regexes; null = language-family defaults (engine-spec §8.4)

mutation:                         # only used when commands.mutate is set
  max_mutants_per_target: 20
  # commands.mutate must print one JSON object per line:
  #   {"id": "...", "file": "...", "patch": "<unified diff>"}
  # The engine applies each patch in a scratch worktree and runs the accepted tests.
```

## Notes

- **JUnit XML is the only result format.** Most runners emit it natively or through a plugin, for example:
  - pytest `--junitxml`;
  - jest `jest-junit`, vitest `--reporter=junit`;
  - `go test` via `gotestsum --junitfile`;
  - `cargo nextest` with a JUnit profile;
  - Maven surefire, `dotnet test --logger junit`.
- **Test ids** are `classname::name` from the XML. The engine maps them back to generated files.
- **`WORKTREE` as the fixed side** means uncommitted changes are included. The engine snapshots them into a temporary commit on a detached ref, so the worktree checkout is exact.
- **Environment:** variables named in `env_passthrough: [...]` reach test commands. By default, only `PATH`, `HOME`, `LANG` and language toolchain variables (`PYTHONPATH`, `NODE_PATH`, `GOPATH`, `JAVA_HOME`, `CARGO_HOME`) are passed.
