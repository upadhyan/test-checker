import { LeakOpts, LeakTarget, redactLeaks } from "./leak";

const ASSERTISH = /\b(expected|actual|assert\w*)\b/i;
const EQ_LITERAL = /[!=]==?\s*(?:["'`\d-]|true\b|false\b|none\b|null\b|nil\b|undefined\b)/i;
export const MAX_REPAIR_BYTES = 4096;

/**
 * engine-spec §8.4 redaction for repair error text: leak redaction, then assertion-looking lines out,
 * values after "got" out, then truncation to 4 KB (applied per test file by the caller's grouping).
 */
export function redactRepairText(text: string, targets: LeakTarget[], opts: LeakOpts = {}): string {
  const lines = redactLeaks(text, targets, opts)
    .split(/\r?\n/)
    .filter((l) => !ASSERTISH.test(l) && !EQ_LITERAL.test(l))
    .map((l) => l.replace(/\bgot\b.*$/i, "got [value redacted]"));
  let out = lines.join("\n");
  if (Buffer.byteLength(out) > MAX_REPAIR_BYTES) out = Buffer.from(out).subarray(0, MAX_REPAIR_BYTES).toString("utf8").replace(/�$/, "") + "\n[truncated]";
  return out;
}
