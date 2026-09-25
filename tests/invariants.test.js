import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tcheck, fixtureRun, tmpdir, writeFiles, ROOT } from "./helpers.js";
import { checkLeak, redactLeaks, normalize, signatureLineCount, significantLines, renderTemplate, parseFrame, parseTextSubmission, parseSpecOutput } from "../dist/tcheck.mjs";

// ---------------- leak check (engine-spec §6) ----------------

const BODY = ["def sum_to(n):", "    if n < 0:", '        raise ValueError("n must be non-negative")', "    total = 0", "    for i in range(n):", "        total += i", "    return total"];
const T = { id: "t", file: "src/fx/stats.py", body_lines: BODY.slice(signatureLineCount(BODY)).map(normalize) };

test("leak: normalisation, signature exclusion, significant lines", () => {
  assert.equal(normalize("   a  =  b ;  "), "a = b");
  assert.equal(normalize("foo(x),"), "foo(x)");
  assert.equal(signatureLineCount(BODY), 1);
  assert.equal(signatureLineCount(["@cache", "def f(a,", "      b):", "    return a"]), 3);
  assert.equal(signatureLineCount(["public int f(int x)", "{", "  return x;", "}"]), 2);
  const sig = significantLines(T);
  assert.ok(sig.includes('raise ValueError("n must be non-negative")'));
  assert.ok(sig.includes("for i in range(n):"));
  assert.ok(!sig.includes("total = 0"), "shorter than 12");
  assert.ok(!sig.some((l) => l.startsWith("def ")), "signature excluded");
});

test("leak: line test fails on a quoted body line, passes on prose", () => {
  assert.equal(checkLeak("Returns the sum 1 + 2 + … + n. Raises ValueError when n is negative.", [T]).passed, true);
  const r = checkLeak("Some prose\n    for i  in range(n):   \nmore", [T]);
  assert.equal(r.passed, false);
  assert.deepEqual(r.findings.map((f) => [f.text_line, f.body_line]), [[2, "for i in range(n):"]]);
});

test("leak: common repo lines and comment/docstring lines never trigger", () => {
  const body = ["def f(x):", '    """Return the thing we compute here."""', "    # explain the approach in words", "    result = compute_everything(x)", "    return result"];
  const t = { id: "f", file: "a.py", body_lines: body.slice(1).map(normalize) };
  assert.equal(checkLeak("Return the thing we compute here.\nexplain the approach in words", [t]).passed, true);
  assert.equal(checkLeak("result = compute_everything(x)", [t]).passed, false);
  assert.equal(checkLeak("result = compute_everything(x)", [t], { common: new Set(["result = compute_everything(x)"]) }).passed, true);
});

test("leak: shingle test catches a lightly reworded copy; threshold configurable", () => {
  const body = ["def f(a, b):", "    accumulator = a * 3 + b", "    accumulator = accumulator - offset_value(a)", "    return accumulator // divisor(b)"];
  const t = { id: "f", file: "a.py", body_lines: body.slice(1).map(normalize) };
  // No full line copied (operators changed), but the token runs are identical.
  const text = "accumulator := a * 3 + b\naccumulator := accumulator - offset_value(a)\nreturn accumulator / divisor(b)";
  const r = checkLeak(text, [t]);
  assert.equal(r.findings.length, 0);
  assert.equal(r.passed, false);
  assert.ok(r.shingle_ratio > 0.25);
  assert.equal(checkLeak(text, [t], { threshold: 1 }).passed, true);
});

test("leak: redact mode replaces offending lines", () => {
  const out = redactLeaks('Traceback:\n    for i in range(n):\nError', [T]);
  assert.equal(out, "Traceback:\n[line from implementation redacted]\nError");
});

// ---------------- renderer (prompts/README.md) ----------------

test("renderer: variables, #if, variants, comments, unknown variables", () => {
  const tpl = "A {{x}} {{o.y}}<!-- a comment -->\n{{#if z}}Z={{z}}{{/if}}{{#if w}}W{{/if}}\n<!-- variant: one -->ONE\n<!-- /variant --><!-- variant: two -->TWO\n<!-- /variant -->";
  assert.equal(renderTemplate(tpl, { x: 1, o: { y: [1, 2] }, z: "z", w: "" }, { name: "t", role: "spec", variant: "two" }), "A 1 1, 2\nZ=z\nTWO");
  assert.throws(() => renderTemplate("{{nope}}", {}, { name: "t", role: "spec" }), /unknown variable \{\{nope\}\}/);
  assert.throws(() => renderTemplate("{{#if nope}}x{{/if}}", {}, { name: "t", role: "spec" }), /unknown variable/);
  assert.equal(renderTemplate("{{#if o.missing}}x{{/if}}ok", { o: {} }, { name: "t", role: "spec" }), "ok");
});

test("renderer: writer/repair templates referencing target.* are refused statically", () => {
  assert.throws(() => renderTemplate("{{#if target.body}}x{{/if}}", { target: {} }, { name: "evil.md", role: "writer" }), /must never see the target body/);
  assert.throws(() => renderTemplate("{{target.symbol}}", { target: { symbol: "s" } }, { name: "evil.md", role: "repair" }), /must never see/);
  for (const f of ["blind-write.md", "repair.md"]) {
    assert.ok(!/\{\{\s*(#if\s+)?target\./.test(fs.readFileSync(path.join(ROOT, "prompts", f), "utf8")), f);
  }
});

test("payload framing and text-submission parsing", () => {
  const f = parseFrame("<<<TCHECK-PAYLOAD v1 id=p-0123abcd role=writer sha256=" + "a".repeat(64) + ">>>\nhello\n<<<END TCHECK-PAYLOAD>>>\n");
  assert.deepEqual(f, { id: "p-0123abcd", role: "writer", sha: "a".repeat(64), body: "hello" });
  const s = parseTextSubmission("Here you go\n\nFILE: test_a_1.py\n```python\nx = 1\n```\n\n**FILE: `test_a_2.py`**\n```\ny = 2\n```\n\nNOTES:\n- ambiguous zero\n");
  assert.deepEqual(s, { files: [{ path: "test_a_1.py", content: "x = 1\n" }, { path: "test_a_2.py", content: "y = 2\n" }], notes: "- ambiguous zero" });
  assert.deepEqual(parseSpecOutput("<analysis>A</analysis>\n<spec>S</spec>"), { spec: "S", analysis: "A" });
  assert.deepEqual(parseSpecOutput("Part 1: x\nPart 3: Final Specification Docstring\nThe spec."), { spec: "The spec.", analysis: "" });
});

// ---------------- end to end through the CLI ----------------

const GOOD_SPEC = `<analysis>
Logical mistakes: the loop stops one short, so n itself is never added.
Robustness omissions: none found
</analysis>
<spec>
sum_to(n) returns the sum of the integers 1 through n inclusive.
- sum_to(0) is 0.
- For n < 0 it raises ValueError.
</spec>`;

function withSpec(name = "off_by_one") {
  const f = fixtureRun(name);
  const tmp = tmpdir();
  const w = (n, s) => (fs.writeFileSync(path.join(tmp, n), s), path.join(tmp, n));
  let r = tcheck(f.dir, ["context", "set", f.run, f.target, "--file", path.join(ROOT, "fixtures", name, "context.json"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  r = tcheck(f.dir, ["spec", "save", f.run, f.target, "--from", w("spec.txt", GOOD_SPEC), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  return { ...f, w };
}

test("invariant 1: context containing the body is rejected (exit 2)", () => {
  const f = fixtureRun("off_by_one");
  const tmp = tmpdir();
  writeFiles(tmp, { "ctx.json": JSON.stringify({ module_signatures: ["def sum_to(n)", "    for i in range(n):"] }) });
  const r = tcheck(f.dir, ["context", "set", f.run, f.target, "--file", path.join(tmp, "ctx.json")]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /contains body line.*for i in range\(n\)/);
  writeFiles(tmp, { "bad.json": JSON.stringify({ nonsense: 1 }) });
  assert.equal(tcheck(f.dir, ["context", "set", f.run, f.target, "--file", path.join(tmp, "bad.json")]).code, 2, "schema");
});

test("invariant 1: a spec that quotes a body line is rejected (exit 2)", () => {
  const f = fixtureRun("off_by_one");
  const tmp = tmpdir();
  writeFiles(tmp, { "spec.txt": '<spec>\nsum_to computes a total.\nIt does: raise ValueError("n must be non-negative")\n</spec>' });
  const r = tcheck(f.dir, ["spec", "save", f.run, f.target, "--from", path.join(tmp, "spec.txt")]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /spec quotes the implementation/);
  assert.equal(tcheck(f.dir, ["spec", "show", f.run, f.target]).code, 1, "nothing saved");
});

test("spec prompt renders the body for the (non-blind) spec role", () => {
  const f = fixtureRun("off_by_one");
  const r = tcheck(f.dir, ["spec", "prompt", f.run, f.target, "--intent", "sum 1..n"]);
  assert.equal(r.code, 0, r.stderr);
  const fr = parseFrame(r.stdout);
  assert.equal(fr.role, "spec");
  assert.match(fr.body, /for i in range\(n\):/);
  assert.match(fr.body, /Developer's stated intent\nsum 1\.\.n/);
  assert.match(fr.body, /Make sure to clearly write out your analysis/, "reasoning variant");
  assert.ok(!/Part 3/.test(fr.body), "scaffold variant dropped");
  assert.ok(!/\{\{|<!--/.test(fr.body));
});

test("manual blind loop: build, emit writer, ingest, exec, classify; payload is single-use and frozen", () => {
  const { dir, run, target, w } = withSpec();
  let r = tcheck(dir, ["bundle", "build", run, target, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const bundle = r.json.bundle;
  assert.equal(bundle, `b-${run.slice(-4)}-${target}`);
  const frozen = JSON.parse(fs.readFileSync(path.join(dir, ".test-checker/bundles", bundle + ".json"), "utf8"));
  assert.equal(frozen.focal.signature, "def sum_to(n):");
  assert.ok(!JSON.stringify(frozen).includes("range(n)"));

  r = tcheck(dir, ["bundle", "emit", bundle, "--role", "writer"]);
  assert.equal(r.code, 0, r.stderr);
  const fr = parseFrame(r.stdout);
  assert.equal(fr.role, "writer");
  assert.ok(!/range\(n\)|n must be non-negative/.test(fr.body), "no body in the writer payload");
  assert.match(fr.body, /Call the `submit_tests` tool exactly once/);
  assert.match(fr.body, new RegExp(`payload_id\`: \`${fr.id}\``));
  assert.match(fr.body, /Required imports: from fx.stats import sum_to/);
  assert.match(fr.body, /test_sum_to_\{n\}\.py/);

  const out = w("out.txt", "FILE: test_sum_to_1.py\n```python\nfrom fx.stats import sum_to\n\ndef test_includes_n():\n    assert sum_to(3) == 6\n\ndef test_zero():\n    assert sum_to(0) == 0\n```\nNOTES:\nnone\n");
  // A bad file name is rejected without consuming the payload.
  const bad = w("bad.txt", "FILE: ../escape.py\n```python\nx=1\n```\n");
  assert.equal(tcheck(dir, ["ingest", fr.id, "--from", bad]).code, 2);
  r = tcheck(dir, ["ingest", fr.id, "--from", out, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.message, `Stored 1 test file for ${target} (round 0).`);
  // Invariant 2: a consumed payload can't be reused.
  r = tcheck(dir, ["ingest", fr.id, "--from", out]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already used/);

  assert.equal(tcheck(dir, ["compose", run]).code, 0);
  assert.equal(tcheck(dir, ["exec", run]).code, 0);
  const cls = tcheck(dir, ["classify", run, "--json"]).json;
  assert.deepEqual(cls.tests.map((t) => [t.name, t.category]).sort(), [["test_includes_n", "effective"], ["test_zero", "neutral"]]);
});

test("invariant 2: a tampered frozen payload fails its hash check", () => {
  const { dir, run, target, w } = withSpec();
  const bundle = tcheck(dir, ["bundle", "build", run, target, "--json"]).json.bundle;
  const fr = parseFrame(tcheck(dir, ["bundle", "emit", bundle, "--role", "writer"]).stdout);
  const file = path.join(dir, ".test-checker/payloads", fr.id + ".md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Specification", "Specificati0n"));
  const r = tcheck(dir, ["ingest", fr.id, "--from", w("o.txt", "FILE: test_sum_to_1.py\n```\nx\n```\n")]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /hash check/);
});

test("invariant 3: a repair payload holds only redacted setup errors, never <failure> text or body lines", () => {
  const { dir, run, target, w } = withSpec();
  const bundle = tcheck(dir, ["bundle", "build", run, target, "--json"]).json.bundle;
  const fr = parseFrame(tcheck(dir, ["bundle", "emit", bundle, "--role", "writer"]).stdout);
  const out = w(
    "o.txt",
    "FILE: test_sum_to_1.py\n```python\nfrom fx.stats import sum_to\nfrom fx.stats import no_such_helper\n\ndef test_a():\n    assert sum_to(3) == 6\n```\n" +
      'FILE: test_sum_to_2.py\n```python\nfrom fx.stats import sum_to\n\ndef test_distinctive_failure():\n    assert sum_to(3) == 424242, "UNIQUE-FAILURE-MARKER"\n```\n',
  );
  assert.equal(tcheck(dir, ["ingest", fr.id, "--from", out]).code, 0);
  tcheck(dir, ["compose", run]);
  // Collection error in file 1 aborts pytest; run file 2 separately so its <failure> exists in the XML.
  assert.equal(tcheck(dir, ["exec", run, "--json"]).json.targets[target].status, "needs_repair");
  // Emit before the writer has been consumed twice: repair works off the latest exec.
  let r = tcheck(dir, ["bundle", "emit", bundle, "--role", "repair", "--run", run]);
  assert.equal(r.code, 0, r.stderr);
  const rp = parseFrame(r.stdout);
  assert.equal(rp.role, "repair");
  assert.match(rp.body, /no_such_helper/);
  // The previous test files are the role's own code; the errors section must hold no <failure> output.
  const errors = rp.body.split("## Errors to fix")[1];
  assert.ok(!/UNIQUE-FAILURE-MARKER|424242|AssertionError|test_distinctive_failure/.test(errors), errors);
  assert.ok(!/for i in range\(n\)|n must be non-negative/.test(rp.body));
  assert.match(rp.body, /round 1 of 3/);

  // Repair submits only the fixed file; the other carries over.
  r = tcheck(dir, ["ingest", rp.id, "--from", w("r.txt", "FILE: test_sum_to_1.py\n```python\nfrom fx.stats import sum_to\n\ndef test_a():\n    assert sum_to(3) == 6\n```\n")]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json === undefined ? 1 : r.json.round, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, `.test-checker/generated/${run}/${target}/round-1`)).sort(), ["round.json", "test_sum_to_1.py", "test_sum_to_2.py"]);
  tcheck(dir, ["compose", run]);
  assert.equal(tcheck(dir, ["exec", run, "--json"]).json.targets[target].status, "ok");
  const cls = tcheck(dir, ["classify", run, "--json"]).json;
  assert.equal(cls.tests.find((t) => t.name === "test_a").category, "effective");
  assert.equal(cls.tests.find((t) => t.name === "test_distinctive_failure").category, "broken");
  // Nothing left to repair.
  assert.equal(tcheck(dir, ["bundle", "emit", bundle, "--role", "repair"]).code, 2);
});

test("spec edit makes existing bundles stale", () => {
  const { dir, run, target, w } = withSpec();
  const bundle = tcheck(dir, ["bundle", "build", run, target, "--json"]).json.bundle;
  assert.equal(tcheck(dir, ["spec", "edit", run, target, "--from", w("e.txt", "sum_to(n) is n*(n+1)/2 for n >= 0.")]).code, 0);
  const r = tcheck(dir, ["bundle", "emit", bundle, "--role", "writer"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /stale/);
});

test("invariants 5 and 6: state changes hit the ledger; every command speaks --json", () => {
  const { dir, run, target } = withSpec();
  tcheck(dir, ["bundle", "build", run, target]);
  const types = fs.readFileSync(path.join(dir, ".test-checker/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
  for (const t of ["run_started", "target_added", "context_set", "spec_saved", "bundle_frozen"]) assert.ok(types.includes(t), t);
  for (const args of [["env"], ["status"], ["scope"], ["spec", "show", run, target]]) {
    const r = tcheck(dir, [...args, "--json"]);
    assert.equal(r.code, 0, args.join(" "));
    assert.ok(r.json, args.join(" "));
  }
  const e = tcheck(dir, ["spec", "show", run, "nope", "--json"]);
  assert.equal(e.code, 1);
  assert.ok(e.json.error);
});
