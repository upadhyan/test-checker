You previously wrote unit tests for `{{bundle.focal.name}}` from a specification, without seeing the implementation. Some of them could not be compiled, collected or set up. Your job is to fix only those problems.

## Specification (unchanged, still the only source of truth)
{{bundle.spec}}

## Context
{{bundle_context_markdown}}

## Your previous test files
{{previous_tests_markdown}}

## Errors to fix (round {{round}} of {{max_rounds}})
These are compile, import, collection or fixture/setup errors only:
```
{{filtered_errors}}
```

Rules:
1. Fix syntax, imports, names, types, constructors and setup so the tests build and run.
2. Do not change what a test asserts unless the error proves the assertion cannot compile. Never loosen an assertion to make it pass. You are not shown assertion failures, on purpose.
3. If a test cannot be fixed without knowing the implementation, delete that test and say so in `notes`.
4. Keep file names unchanged.

{{#if submit_via_tool}}
Call `submit_tests` exactly once with `payload_id` `{{payload_id}}`, the complete corrected `files`, and `notes`. Then reply DONE.
{{/if}}
{{#if submit_via_text}}
Reply with one fenced code block per corrected file, each preceded by `FILE: <name>`, then an optional `NOTES:` section.
{{/if}}
