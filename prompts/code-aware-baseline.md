<!-- Selftest baseline only: the paper's code-based setting (Figure 2 with source code). Never used in normal runs. -->
You are a professional who writes {{language}} test methods. Please help me write some unit tests in {{language}} language, details are listed below:

## Code under test
`{{target.symbol}}` in `{{target.file}}`

```{{language_tag}}
{{target.body}}
```

## Context
{{context_markdown}}

Please write some unit tests in {{language}} and {{framework}} with maximizing both branch and line coverage. Please ensure that the output format is Markdown, and no explanations needed.

Reply with one fenced code block per test file. Put the file name on the line before each block as `FILE: <name>`, using the pattern `{{test_file_pattern}}`.
