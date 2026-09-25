import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT, TcheckError, usage } from "./util";
import { Repo } from "./repo";
import { envReport } from "./env";
import { init } from "./init";
import { dirtyFiles, scope, waive } from "./dirty";

export interface Args {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Flags that take several values (until the next `--flag`). */
const MULTI = new Set(["existing", "tests", "fixtures", "use"]);
/** Flags that never take a value. */
const BOOL = new Set(["json", "quiet", "force", "keep", "all-accepted", "include-neutral", "help", "with-intent"]);

export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") {
      a._.push(...argv.slice(i + 1));
      break;
    }
    if (t.startsWith("--")) {
      let [k, v] = t.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (BOOL.has(k)) a.flags[k] = true;
      else if (MULTI.has(k)) {
        const vals: string[] = v !== undefined ? [v] : [];
        while (v === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
        a.flags[k] = [...((a.flags[k] as string[]) ?? []), ...vals];
      } else {
        if (v === undefined) {
          if (i + 1 >= argv.length) throw usage(`--${k} needs a value`);
          v = argv[++i];
        }
        a.flags[k] = v;
      }
    } else a._.push(t);
  }
  return a;
}

export const str = (a: Args, k: string): string | undefined => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
export const list = (a: Args, k: string): string[] => (Array.isArray(a.flags[k]) ? (a.flags[k] as string[]) : typeof a.flags[k] === "string" ? [a.flags[k] as string] : []);
export const bool = (a: Args, k: string): boolean => a.flags[k] === true;

function need(a: Args, i: number, name: string): string {
  const v = a._[i];
  if (!v) throw usage(`missing <${name}>`);
  return v;
}

/** What a command returns: data for --json and a human rendering. */
export interface Out {
  data: unknown;
  human?: string;
  code?: number;
}

type Handler = (a: Args) => Out | Promise<Out>;

const repoOf = (a: Args, requireConfig = true) => Repo.open({ root: str(a, "root"), requireConfig });

const COMMANDS: Record<string, Handler> = {
  env: (a) => {
    const r = envReport({ root: str(a, "root"), harness: str(a, "harness") });
    return { data: r, human: Object.entries(r).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") || "-" : v ?? "-"}`).join("\n") };
  },
  init: (a) => {
    const r = init(repoOf(a, false), { language: str(a, "language"), framework: str(a, "framework"), force: bool(a, "force") });
    return { data: r, human: [`Wrote ${r.config} from examples/${r.example}.`, ...r.warnings.map((w) => `warning: ${w}`), "Next: edit it, then run `tcheck doctor`."].join("\n") };
  },
  status: async (a) => (await import("./status")).status(repoOf(a)),
  scope: (a) => {
    const r = scope(repoOf(a), str(a, "since"));
    return { data: r, human: r.length ? r.map((e) => `${e.file} ${e.ranges.map(([x, y]) => `${x}-${y}`).join(",")}${e.verified ? " (verified)" : ""}`).join("\n") : "No changed source files." };
  },
  waive: (a) => {
    const files = waive(repoOf(a), a._.slice(1), str(a, "reason") ?? "");
    return { data: { waived: files }, human: `Waived ${files.length} file(s).` };
  },
};

export function register(name: string, h: Handler): void {
  COMMANDS[name] = h;
}

const HELP = `tcheck — test-checker engine

Usage: tcheck <command> [args] [--json] [--root DIR] [--harness NAME] [--quiet]

Setup:      env | init | doctor | status | scope | waive
Run:        run start | target add | context set | spec prompt|save|show|edit
            bundle build|emit | blind-run | ingest | compose | exec | classify
            adjudicate queue|prompt|save|override | report | promote
Integrate:  hook <event> | mcp | selftest

See docs/engine-spec.md §5.`;

/** Subcommand groups dispatch on their second word, e.g. `run start`. */
function commandKey(a: Args): [string, Args] {
  const [first, second] = a._;
  if (first && second && COMMANDS[`${first} ${second}`]) return [`${first} ${second}`, { ...a, _: a._.slice(1) }];
  return [first, a];
}

export async function main(argv: string[]): Promise<number> {
  let json = false;
  try {
    const a = parseArgs(argv);
    json = bool(a, "json");
    if (!a._.length || bool(a, "help")) {
      process.stdout.write(HELP + "\n");
      return a._.length || bool(a, "help") ? EXIT.OK : EXIT.USAGE;
    }
    await loadCommands();
    const [key, args] = commandKey(a);
    const h = COMMANDS[key];
    if (!h) throw usage(`unknown command: ${a._.slice(0, 2).join(" ")}\n\n${HELP}`);
    const out = await h(args);
    if (out.data !== undefined || out.human !== undefined) {
      if (json) process.stdout.write(JSON.stringify(out.data, null, 2) + "\n");
      else if (!bool(a, "quiet") && out.human !== undefined) process.stdout.write(out.human.endsWith("\n") ? out.human : out.human + "\n");
    }
    return out.code ?? EXIT.OK;
  } catch (e: any) {
    const code = e instanceof TcheckError ? e.code : EXIT.COMMAND;
    const msg = e instanceof TcheckError ? e.message : `internal error: ${e?.stack ?? e}`;
    if (json) process.stdout.write(JSON.stringify({ error: msg, code, details: e?.details }, null, 2) + "\n");
    process.stderr.write(`tcheck: ${msg}\n`);
    return code;
  }
}

/** Command modules register themselves; imported lazily so hooks stay fast. */
async function loadCommands(): Promise<void> {
  await import("./commands");
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export { dirtyFiles };
export * from "./lib";

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
