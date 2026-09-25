import { Repo } from "./repo";
import { dirtyFiles } from "./dirty";
import type { Out } from "./cli";

export function status(repo: Repo): Out {
  const dirty = dirtyFiles(repo);
  const data = { gate: repo.config.gate, dirty_files: dirty, open_runs: [] as string[], unresolved_verdicts: [] as unknown[] };
  const human = [`gate: ${data.gate}`, `dirty: ${dirty.length ? dirty.join(", ") : "none"}`].join("\n");
  return { data, human };
}
