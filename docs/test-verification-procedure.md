# Unit Test Verification Procedure

Procedure extracted from **Zhao, Zhou & Cohen — "Evaluating and Mitigating the Misguidance Effect of Buggy Code in LLM-Generated Unit Tests"** (University of Toronto), [arXiv:2607.22883](https://arxiv.org/abs/2607.22883).

This document covers the procedure only. Experimental results are omitted except where they justify a design decision. Details the paper does not specify are flagged as **Not specified**.

---

## 1. Overview

**Goal.** Decide whether an LLM-generated unit test actually checks the *intended* behaviour of a method, or instead enshrines whatever the (possibly buggy) implementation does.

**Core idea: dual execution.** Every generated test is run against two versions of the same method:

- the **buggy** version (what the LLM was shown), and
- the **fixed** version (treated as the ground-truth specification).

Comparing the two pass/fail outcomes classifies each test into one of four categories (§6). The category of interest is the **misguided test**: one that passes on buggy code and fails on fixed code.

**Key definitions (verbatim).**

- *Misguidance effect*: buggy code "steers LLMs toward generating tests that validate its erroneous behavior rather than expose it."
- *Misguided test*: a test that "pass[es] on the buggy version but fail[s] on its bug-free counterpart."
- *Effective test*: a test that fails on the buggy code and passes on the fixed version.

**Pipeline at a glance.**

```
Defects4J bug ──► focal-method selection (§2)
                    │
                    ▼
            context construction (§3)
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  code-based prompt      spec-based prompt (§8)
  (baseline)             code ─► docstring ─► tests
        └───────────┬────────────┘
                    ▼
          LLM test generation (§4)
                    ▼
     Tree-sitter extraction + file composition (§5)
                    ▼
     compile & run on BUGGY and FIXED versions (§6)
                    ▼
        four-way classification + metrics (§7)
                    ▼
     optional: error-feedback refinement rounds (§9)
```

---

## 2. Benchmark Curation

**Source.** Defects4J v3.0: 854 real bugs across 17 open-source Java projects. Each bug provides a buggy version, a fixed version, and human-written bug-triggering tests.

**Focal-method selection criteria.**

1. **Visibility:** include all non-private methods (public, protected, package-private/default).
2. **Present in both versions:** "The focal method must exist in both the buggy and fixed versions to enable meaningful performance comparisons." Methods that the patch adds or removes are excluded.
3. **Bug-relevant:** "only retain focal methods that trigger at least one existing human-written test in Defects4J with its buggy version." This ensures the method is actually involved in the bug.

**Output.** 318 focal methods covering 233 defects.

---

## 3. Context Construction

For each focal method, the LLM receives the following context (following Yang et al.'s context design):

| Element | Purpose |
|---|---|
| Focal method source (or a generated docstring, see §8) | The thing under test |
| Method signature and parameters | API shape |
| Enclosing class constructor(s) | How to instantiate the class under test |
| Declared fields of the class | State the method may read or write |
| Other methods in the same class (signatures) | Setup, helpers, observers for assertions |
| Constructors of user-defined parameter/return types | How to build arguments and inspect return values |

**Not specified:** truncation limits, and whether the other methods are given as full bodies or signatures only.

---

## 4. Test Generation

**Prompt (Figure 2, verbatim):**

```text
You are a professional who writes Java test methods. Please help me write some unit
tests in Java language, details are listed below:

<Code under test and/or LLM-generated docstring, and other focal method-related contexts>

Please write some unit tests in Java 11 and Junit 4 with maximizing both branch and
line coverage. Please ensure that the output format is Markdown, and no explanations
needed.
```

**Models.** 11 LLMs from six developers:

| Developer | Models |
|---|---|
| Google | Gemini 2.5 Pro, Gemini 2.5 Flash |
| Anthropic | Claude 4 Sonnet (base and reasoning modes) |
| xAI | Grok-4, Grok-3 |
| OpenAI | GPT-4.1, o4-mini |
| DeepSeek | DeepSeek-V3, DeepSeek-R1 |
| Alibaba | Qwen3-Coder-Plus, Qwen3-Plus |

Models are split into **base** and **reasoning** groups. This matters for the advanced docstring prompt (§8.1).

**Decoding.** Temperature 0 "where possible, to promote deterministic outputs."

**Target framework.** Java 11, JUnit 4.

**Not specified:** max tokens, number of tests per request, number of samples per focal method.

---

## 5. Test Extraction and Composition

1. **Parse the response.** Extract Markdown code blocks and parse them with **Tree-sitter** (Java grammar).
2. **Identify artifacts.** Using the AST, collect:
   - test methods (JUnit `@Test` methods),
   - import statements,
   - helper methods/classes the model defined.
3. **Compose test files.** Combine the extracted content with:
   - **project-specific dependencies** (the focal class's package and project imports), and
   - a **curated set of common imports** for the JDK (e.g., `java.util.*`) and JUnit (e.g., `org.junit.Assert`),

   "to prevent compilation failures from missing imports."
4. **Compile.** Tests that fail to compile are recorded as compilation failures. These feed the compilation failure rate (§7.4) and the refinement loop (§9).

**Not specified:** per-test vs. per-file compilation isolation, timeouts, handling of non-deterministic (flaky) tests.

---

## 6. Dual-Execution Verification

### 6.1 Procedure

For each compiled test file of focal method *m* from bug *b*:

1. Check out the **buggy** version of *b* (Defects4J), install the test file, compile, run it, and record the pass/fail result for each test method.
2. Check out the **fixed** version of *b*, install the *same* test file, compile, run it, and record the pass/fail result for each test method.
3. Classify each test method using the table in §6.2.

The fixed version is the "gold standard for intended program behavior." A test's correctness is judged only by how it behaves across the two versions. No human oracle or LLM judge is used.

### 6.2 Four-Way Classification (Table 2)

| Category | On fixed code | On buggy code | Meaning |
|---|---|---|---|
| **True Positive — Effective** | Pass | Fail | Detects the bug |
| **False Negative — Misguided** | Fail | Pass | Encodes the buggy behaviour as expected |
| True Negative | Pass | Pass | Valid, but doesn't touch the bug |
| False Positive | Fail | Fail | Asserts hallucinated/incorrect behaviour |

### 6.3 Reference implementation sketch

```python
def classify(pass_fixed: bool, pass_buggy: bool) -> str:
    if pass_fixed and not pass_buggy:
        return "effective"        # true positive
    if not pass_fixed and pass_buggy:
        return "misguided"        # false negative
    if pass_fixed and pass_buggy:
        return "true_negative"
    return "false_positive"       # fails on both
```

---

## 7. Metrics

### 7.1 Test-level

- **# / % misguided tests** per model (the paper's primary metric).
- **# / % effective tests** per model.

Percentages are computed over the tests the model generated.

### 7.2 Method-level

- **Detected methods:** number of unique buggy focal methods with **at least one** effective test.
- **Misguided methods:** number of unique focal methods with **at least one** misguided test.

### 7.3 Sequence score (model confidence)

Measures how confident a model is in a generated test *T*, given context *C*:

```latex
S(T, C) = \frac{1}{|T|} \sum_{i=1}^{|T|} \log P(t_i \mid C, t_1, \dots, t_{i-1})
```

This is the average per-token log-probability. The paper uses it to compare how "natural" misguided tests look relative to effective ones.

- **Scorers:** three open-weight models (DeepSeek-V3, Qwen3-Coder-Plus, GPT-OSS-120B).
- **Cross-model scoring:** each scorer only scores tests generated by *other* developers' models, to avoid self-evaluation bias.

### 7.4 Quality on bug-free code

Used to check that the mitigation doesn't degrade tests when the code is correct (§10):

- **Compilation Failure Rate (CFR):** fraction of generated tests that fail to compile.
- **False-Alarm Rate (FAR):** fraction of tests that fail on correct code.
- **Line coverage** and **branch coverage** of the focal method.

**Not specified:** coverage tool (JaCoCo is the Defects4J default).

---

## 8. Specification-Based Mitigation

**Principle.** Buggy source code biases the LLM toward its actual (wrong) behaviour. So first derive a natural-language **specification** of the *intended* behaviour, then generate tests from that specification **instead of** the code.

> "the code must be removed entirely, rather than merely supplemented, to meaningfully mitigate misguidance."

In the paper's ablation, giving the model both the code and the docstring still left it misguided. Only removing the code worked.

### 8.1 Step 1: Docstring generation

All variants share one prompt body. A postfix then selects the variant.

**Shared main body (Figure 3):**

```text
You are a professional Java developer. Please help identify the intention and
functionality of the method detailed below:
<code under test and related information>
```

**Variant A: Base docstring postfix**

```text
Please provide a formal docstring that identifies the functionality and intention of
the given method. Please avoid directly quoting from the focal method code, as it
might be buggy, and output only the docstring.
```

**Variant B: Advanced docstring postfix** (critical-analysis prompt)

```text
Please provide a formal docstring that identifies the functionality and intended
specification of the given method. To do this, first perform a critical analysis from
the perspective of an expert software engineer auditing for quality and correctness.
Your analysis must identify two types of potential issues:
1. Logical Mistakes: Scrutinize the algorithm's logic. Based on the method's name and
   context, does its implementation correctly achieve its apparent goal, or are there
   logical flaws that would produce an incorrect result even on a "happy path"?
2. Robustness Omissions: Check for missing but necessary steps that production-quality
   code would include.
```

This is followed by a model-type-specific output requirement:

*For reasoning models:*

```text
Make sure to clearly write out your analysis. Based on this two-part analysis, the
docstring should describe the specification for a correct and robust version of the
method, capturing the developer's likely intent.
```

*For base (non-reasoning) models*, an explicit three-part scaffold replaces the model's missing internal reasoning:

```text
Your output should come in three parts.
Part 1: Critical Analysis. Clearly state the logical mistakes and robustness omissions
found.
Part 2: Fixes Required. List all fixes required to correct the identified logical
errors and robustness omissions.
Part 3: Final Specification Docstring. Based on Part 2, write a formal docstring
describing the corrected behavior.
```

Robustness omissions include missing null validation, boundary-condition checks and error handling.

### 8.2 Step 2: Tests from the specification

1. Take the generated docstring (for the base-model scaffold, **Part 3 only**).
2. Build the §4 prompt, putting the **docstring in place of the focal method body**. Keep the rest of the context (signature, constructors, fields, other methods, type constructors).
3. Generate, extract, compose and verify exactly as in §5–§7.

---

## 9. Multi-Round Refinement

An iterative repair loop that runs on top of either input mode (code or spec):

1. Generate tests (round 0) and run them.
2. **If a generated test fails to execute**, extract the resulting error message (compiler or runtime) and "append it to the original context."
3. Resubmit the augmented prompt to the LLM "with instructions to revise the test suite."
4. Re-extract, recompile and re-run on both versions.
5. Repeat for **3 rounds**.

Metrics tracked each round: compiled test count, effective tests, misguided tests, and methods with at least one detected bug.

**Design note.** Execution feedback comes from running on the buggy version, so repair can push tests *toward* the buggy behaviour. Spec-based input reduces this drift.

**Not specified:** whether feedback comes from the buggy run only; exact wording of the revision instruction; whether passing tests are kept fixed between rounds.

---

## 10. Applicability Check on Bug-Free Code

The paper checks that the mitigation is safe to use when the code is *not* buggy:

1. Use the **fixed** version of each focal method as the input code.
2. Run the baseline (code → tests) and the approach (code → docstring → tests).
3. Compare CFR, FAR, line coverage and branch coverage (§7.4).

---

## 11. Manual Docstring Inspection Protocol

Checks whether generated specifications recover the intended behaviour.

- **Sample:** all 318 advanced-prompt docstrings from each of two models (Gemini 2.5 Pro, Qwen3-Coder-Plus).
- **Annotators:** two independent annotators (one author, one external).
- **Labels** (binary, not mutually exhaustive):
  1. docstring *preserves the original bug* from the buggy focal method;
  2. docstring *describes the corrected behavior* needed to fix the bug.
- **Agreement:** Cohen's κ, computed separately per label and per model.
- **Resolution:** "Disagreements were then resolved through discussion, and the consensus labels were used for the final analysis."

---

## 12. Reproduction Checklist

- [ ] Defects4J v3.0 installed; buggy/fixed checkouts scripted per bug
- [ ] Focal-method filter implemented (non-private, present in both versions, triggers ≥1 human test on buggy)
- [ ] Context extractor (signature, constructors, fields, sibling methods, user-type constructors)
- [ ] Test-generation prompt (§4) with temperature 0
- [ ] Docstring prompts (§8.1): base, advanced + reasoning postfix, advanced + base-model scaffold
- [ ] Tree-sitter extractor + test-file composer with curated JDK/JUnit imports
- [ ] Runner that executes each test file on **both** versions and records per-test outcomes
- [ ] Four-way classifier (§6.3) and metric aggregation (§7)
- [ ] Coverage collection (e.g., JaCoCo) on the focal method
- [ ] Optional: 3-round error-feedback refinement loop (§9)
- [ ] Optional: sequence-score computation with cross-model scorers (§7.3)

### Open details to decide when reimplementing

| Detail | Paper | Suggested default |
|---|---|---|
| Tests per request / samples per method | Not specified | 1 request per method at T=0 |
| Max output tokens | Not specified | Model default |
| Compile granularity | Not specified | Drop only non-compiling test methods, keep the rest of the file |
| Timeouts | Not specified | Per-test timeout (e.g., JUnit `@Test(timeout=…)`) |
| Flaky tests | Not discussed | Re-run each version ≥3× and discard inconsistent tests |
| Coverage tool | Not specified | JaCoCo (Defects4J built-in) |
| Refinement feedback source | Not specified | Errors from the version shown to the LLM |
