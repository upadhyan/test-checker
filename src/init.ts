import * as fs from "node:fs";
import * as path from "node:path";
import { IGNORED, Repo, parseConfig, pluginRoot } from "./repo";
import { TcheckError, EXIT, writeText } from "./util";

const ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  ts: "typescript",
  js: "typescript",
  javascript: "typescript",
  golang: "go",
  kotlin: "java",
  scala: "java",
  rs: "rust",
};

/** Guess the language from build files when --language is not given. */
function detectLanguage(root: string): string | null {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  if (has("pyproject.toml") || has("setup.py") || has("setup.cfg") || has("requirements.txt")) return "python";
  if (has("go.mod")) return "go";
  if (has("Cargo.toml")) return "rust";
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) return "java";
  if (has("package.json")) return "typescript";
  return null;
}

export function init(repo: Repo, opts: { language?: string; framework?: string; force?: boolean }) {
  if (repo.hasConfig() && !opts.force) {
    throw new TcheckError(`${repo.rel(repo.configPath)} already exists (use --force to overwrite)`, EXIT.USAGE);
  }
  const wanted = (opts.language ?? detectLanguage(repo.root) ?? "python").toLowerCase();
  const lang = ALIASES[wanted] ?? wanted;
  const examples = path.join(pluginRoot(), "examples");
  const exact = path.join(examples, `config.${lang}.yaml`);
  const source = fs.existsSync(exact) ? exact : path.join(examples, "config.python.yaml");
  let text = fs.readFileSync(source, "utf8");
  const warnings: string[] = [];
  if (!fs.existsSync(exact)) warnings.push(`no example for "${wanted}"; started from the Python example. Edit commands and globs.`);
  if (opts.language && wanted !== lang) warnings.push(`using the ${lang} example for "${wanted}"`);
  if (opts.language) text = text.replace(/^language: .*$/m, `language: ${opts.language}`);
  if (opts.framework) text = text.replace(/^framework: .*$/m, `framework: ${JSON.stringify(opts.framework)}`);
  parseConfig(text, "generated config"); // never write something doctor would reject on schema

  writeText(repo.configPath, text);
  writeText(repo.p(".gitignore"), IGNORED.join("\n") + "\n");
  repo.ledger("initialized", { language: opts.language ?? lang, example: path.basename(source) });
  return { config: repo.rel(repo.configPath), example: path.basename(source), warnings };
}
