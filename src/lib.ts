// Library API for the OpenCode and Pi integrations (engine-spec §13, §15), and for tests.
export { Repo, findRoot, parseConfig, pluginRoot } from "./repo";
export { detectHarness, resolveBackend } from "./env";
export { parseYaml } from "./yaml";
export { validate } from "./schema";
export { globToRegex, matchGlobs } from "./util";
export { buildFixtureRepo, listFixtures, loadFixture } from "./fixtures";
export { parseJUnit } from "./junit";
export { checkLeak, redactLeaks, normalize, signatureLineCount, significantLines } from "./leak";
export { redactRepairText } from "./repair";
export { renderTemplate, parseFrame, frame, loadPayload, payloadIndex } from "./payload";
export { parseTextSubmission, submitTests } from "./bundle";
export { parseSpecOutput } from "./spec";
export { mapRange, parseVerdict } from "./adjudicate";
