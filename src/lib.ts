// Library API for the OpenCode and Pi integrations (engine-spec §13, §15), and for tests.
export { Repo, findRoot, parseConfig, pluginRoot } from "./repo";
export { detectHarness, resolveBackend } from "./env";
export { parseYaml } from "./yaml";
export { validate } from "./schema";
export { globToRegex, matchGlobs } from "./util";
