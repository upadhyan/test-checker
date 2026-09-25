You are a professional who writes {{language}} test methods. Please help me write some unit tests in {{language}}, details are listed below.

You have NOT been shown the implementation, on purpose. The specification below is the only source of truth for expected behaviour. Do not guess implementation details, and do not ask for the source code.

## Unit under test
- Symbol: `{{bundle.focal.name}}`
- Signature: `{{bundle.focal.signature}}`
- Location (for imports only): `{{bundle.focal.file}}`

## Specification
{{bundle.spec}}

## Context
{{bundle_context_markdown}}

## Test conventions
- Framework: {{framework}}
- Test file naming: `{{test_file_pattern}}`
{{#if bundle.context.test_conventions.imports}}- Required imports: {{bundle.context.test_conventions.imports}}{{/if}}
{{#if bundle.context.test_conventions.example_test}}
Example of a test in this project (style reference only):
```{{language_tag}}
{{bundle.context.test_conventions.example_test}}
```
{{/if}}

Please write some unit tests in {{language}} and {{framework}} with maximizing both branch and line coverage.

<!-- [tc] rules added on top of the paper's prompt -->
Rules:
1. Assert only behaviour the specification states or clearly implies. If the spec is silent on a case, do not assert a specific result for it.
2. One behaviour per test. Name each test after the behaviour it checks.
3. Cover the edge cases, preconditions and error behaviour the spec mentions.
4. Tests must be self-contained and deterministic: no network, no wall-clock time, no randomness without a fixed seed.

## How to return the tests
{{#if submit_via_tool}}
Call the `submit_tests` tool exactly once with:
- `payload_id`: `{{payload_id}}`
- `files`: a list of `{ "path": "<file name>", "content": "<full file contents>" }`, using the naming pattern above
- `notes`: optional, any spec ambiguity you noticed

Then reply with the single word DONE.
{{/if}}
{{#if submit_via_text}}
Reply with one fenced code block per test file. Put the file name on the line before each block as `FILE: <name>`. No other prose, except an optional final section headed `NOTES:` listing spec ambiguities.
{{/if}}
