import { Repo } from "./repo";
import { dirtyFiles } from "./dirty";
import { openRuns, unresolved } from "./verdicts";
import type { Out } from "./cli";

export function status(repo: Repo): Out {
  const dirty = dirtyFiles(repo);
  const runs = openRuns(repo);
  const open = runs.flatMap((r) => unresolved(repo, r));
  const data = { gate: repo.config.gate, dirty_files: dirty, open_runs: runs, unresolved_verdicts: open };
  const human = [
    `gate: ${data.gate}`,
    `unverified source files: ${dirty.length ? dirty.join(", ") : "none"}`,
    `open runs: ${runs.length ? runs.join(", ") : "none"}`,
    ...(open.length ? ["unresolved verdicts:", ...open.map((u) => `  ${u.verdict}: ${u.test} (${u.run})`)] : ["unresolved verdicts: none"]),
  ].join("\n");
  return { data, human };
}
