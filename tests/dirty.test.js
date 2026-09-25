import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { git, tcheck, writeFiles } from "./helpers.js";
import { buildFixtureRepo } from "../dist/tcheck.mjs";

test("dirty files, scope hunks and waive", () => {
  const { dir } = buildFixtureRepo("off_by_one");
  let r = tcheck(dir, ["status", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.dirty_files, []);

  const f = path.join(dir, "src/fx/stats.py");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("total = 0", "total = 0  # start"));
  writeFiles(dir, { "src/fx/new_mod.py": "def f():\n    return 1\n", "README.md": "not source\n" });
  r = tcheck(dir, ["status", "--json"]);
  assert.deepEqual(r.json.dirty_files, ["src/fx/new_mod.py", "src/fx/stats.py"]);

  r = tcheck(dir, ["scope", "--json"]);
  assert.deepEqual(r.json, [
    { file: "src/fx/new_mod.py", ranges: [[1, 2]], verified: false, untracked: true },
    { file: "src/fx/stats.py", ranges: [[7, 7]], verified: false },
  ]);
  r = tcheck(dir, ["scope", "--since", "HEAD~1", "--json"]);
  assert.deepEqual(r.json.find((e) => e.file === "src/fx/stats.py").ranges, [[7, 8]]);

  r = tcheck(dir, ["waive", "src/fx/stats.py", "--reason", "comment only", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(tcheck(dir, ["status", "--json"]).json.dirty_files, ["src/fx/new_mod.py"]);
  assert.equal(tcheck(dir, ["scope", "--json"]).json.find((e) => e.file === "src/fx/stats.py").verified, true);
  assert.equal(tcheck(dir, ["waive", "src/fx/stats.py"]).code, 1, "reason required");

  // Editing again makes it dirty again.
  fs.appendFileSync(f, "\n# more\n");
  assert.deepEqual(tcheck(dir, ["status", "--json"]).json.dirty_files, ["src/fx/new_mod.py", "src/fx/stats.py"]);
  // Committing without verification clears it (documented v1 limitation).
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "c");
  assert.deepEqual(tcheck(dir, ["status", "--json"]).json.dirty_files, []);
  const ledger = fs.readFileSync(path.join(dir, ".test-checker/ledger.jsonl"), "utf8");
  assert.match(ledger, /"type":"waived".*"reason":"comment only"/);
});
