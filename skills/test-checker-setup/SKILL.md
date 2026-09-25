---
name: test-checker-setup
description: Set up test-checker in a repository by writing and validating .test-checker/config.yaml. Use when the user asks to set up, configure or initialise test-checker, or when verify-tests finds no config.
license: MIT
---

# test-checker-setup

The goal is a working `.test-checker/config.yaml` that the user has confirmed. Every field is documented in `../verify-tests/references/config-reference.md`, and there are ready-made examples in the plugin's `examples/` folder.

## Steps

1. **Check the environment.**

   ```
   tcheck env --json
   ```

   You need `node` and `git`, and a git repository. If any is missing, stop and say so.

2. **Detect the stack.** Read the build and test files that exist: `pyproject.toml`, `setup.cfg`, `package.json`, `go.mod`, `pom.xml`, `build.gradle*`, `Cargo.toml`, `*.csproj`, CI config. Identify the language, test framework, how tests are normally run, and where source and tests live.

3. **Draft the config.**

   ```
   tcheck init --language <lang> --framework <fw>
   ```

   This writes a skeleton from the closest example. Then edit it:

   - `source_globs`: the source directories only.
   - `test_dir`: somewhere the test runner discovers and can import the project from, e.g. `tests/tcheck/`.
   - `commands.run`: the project's normal test command, narrowed to `{files}`, **writing JUnit XML to `{junit}`**. If the runner needs a plugin for JUnit output (jest-junit, gotestsum, a nextest profile), tell the user what to add. Don't install it without asking.
   - `commands.setup` / `commands.compile`: only if the project needs them.

4. **Check it works.**

   ```
   tcheck doctor
   ```

   This validates the schema, creates a throwaway test in `test_dir`, runs `commands.run`, and confirms JUnit XML is produced and parsed. Fix and repeat until it passes.

5. **Choose the gate.** Ask the user whether the stop gate should be `off`, `warn` (default) or `block`.

6. **Finish.** Suggest committing `.test-checker/config.yaml`, and adding the following to the repo's `.gitignore`:

   ```
   .test-checker/runs/
   .test-checker/bundles/
   .test-checker/generated/
   .test-checker/worktrees/
   ```

   Reports and the ledger (`.test-checker/reports/`, `.test-checker/ledger.jsonl`) are worth committing.
