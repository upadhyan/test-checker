import * as fs from "node:fs";
import * as path from "node:path";
import { Repo, pluginRoot } from "./repo";
import { TcheckError, EXIT, nowIso, randHex, readJson, rejected, sha256, usage, writeJson, writeText } from "./util";

export type Role = "spec" | "writer" | "repair" | "adjudicate" | "baseline";
export const BLIND_ROLES: Role[] = ["writer", "repair"];

// ---------------- template rendering (prompts/README.md) ----------------

const lookup = (vars: Record<string, any>, name: string): any => name.split(".").reduce((o, k) => (o == null ? undefined : o[k]), vars as any);

const present = (v: any): boolean => v !== undefined && v !== null && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

/** Static check: blind templates may never reference target.* (prompts/README.md). */
export function assertBlindSafe(template: string, name: string): void {
  const m = /\{\{\s*(?:#if\s+)?(target\.[\w.]*)\s*\}\}/.exec(template);
  if (m) throw rejected(`template ${name} references ${m[1]}; writer and repair templates must never see the target body`);
}

export function renderTemplate(template: string, vars: Record<string, any>, opts: { name: string; role: Role; variant?: string }): string {
  if (BLIND_ROLES.includes(opts.role)) assertBlindSafe(template, opts.name);
  let t = template.replace(/<!--\s*variant:\s*([\w-]+)\s*-->\n?([\s\S]*?)<!--\s*\/variant\s*-->\n?/g, (_, v: string, body: string) => (v === opts.variant ? body : ""));
  t = t.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n/gm, "").replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(/\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, name: string, body: string) => {
    if (!(name.split(".")[0] in vars)) throw usage(`template ${opts.name}: unknown variable {{#if ${name}}}`);
    return present(lookup(vars, name)) ? body : "";
  });
  if (/\{\{\s*(#if|\/if)/.test(t)) throw usage(`template ${opts.name}: unbalanced {{#if}} block`);
  t = t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name: string) => {
    const v = lookup(vars, name);
    if (v === undefined || v === null) throw usage(`template ${opts.name}: unknown variable {{${name}}}`);
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") throw usage(`template ${opts.name}: {{${name}}} is an object`);
    return String(v);
  });
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function renderPrompt(file: string, vars: Record<string, any>, role: Role, variant?: string): string {
  const p = path.join(pluginRoot(), "prompts", file);
  return renderTemplate(fs.readFileSync(p, "utf8"), vars, { name: file, role, variant });
}

// ---------------- payload store (engine-spec §7) ----------------

export interface PayloadEntry {
  id: string;
  role: Role;
  run: string;
  target?: string;
  bundle?: string;
  round?: number;
  test?: string;
  sha256: string;
  consumed: boolean;
  created_at: string;
  consumed_at?: string;
}

const HEADER = /^<<<TCHECK-PAYLOAD v1 id=(p-[0-9a-f]{8}) role=(\w+) sha256=([0-9a-f]{64})>>>\n([\s\S]*)\n<<<END TCHECK-PAYLOAD>>>$/;

export function newPayloadId(): string {
  return `p-${randHex(8)}`;
}

export function frame(id: string, role: Role, body: string): { full: string; sha: string } {
  const text = body.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const sha = sha256(text);
  return { full: `<<<TCHECK-PAYLOAD v1 id=${id} role=${role} sha256=${sha}>>>\n${text}\n<<<END TCHECK-PAYLOAD>>>`, sha };
}

export function parseFrame(full: string): { id: string; role: string; sha: string; body: string } | null {
  const m = HEADER.exec(full.replace(/\r\n?/g, "\n").trim());
  return m ? { id: m[1], role: m[2], sha: m[3], body: m[4] } : null;
}

function indexPath(repo: Repo): string {
  return repo.p("payloads", "index.json");
}

/** Serialise index.json read-modify-write across concurrent engine processes. */
function withIndexLock<T>(repo: Repo, fn: (idx: Record<string, PayloadEntry>) => T): T {
  const lock = repo.p("payloads", "index.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch {
      if (Date.now() > deadline) fs.rmSync(lock, { force: true }); // stale lock from a crashed process
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const idx = readJson<Record<string, PayloadEntry>>(indexPath(repo), {});
    const out = fn(idx);
    writeJson(indexPath(repo), idx);
    return out;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function storePayload(repo: Repo, e: Omit<PayloadEntry, "sha256" | "consumed" | "created_at" | "id"> & { id?: string }, body: string): { id: string; full: string; entry: PayloadEntry } {
  const id = e.id ?? newPayloadId();
  const { full, sha } = frame(id, e.role, body);
  writeText(repo.p("payloads", `${id}.md`), full);
  const entry: PayloadEntry = { ...e, id, sha256: sha, consumed: false, created_at: nowIso() };
  withIndexLock(repo, (idx) => {
    idx[id] = entry;
  });
  repo.ledger("payload_emitted", { run: e.run, payload: id, role: e.role, sha256: sha, ...(e.target ? { target: e.target } : {}), ...(e.test ? { test: e.test } : {}) });
  return { id, full, entry };
}

/** Load a payload and verify its file against the registered hash (invariant 2). */
export function loadPayload(repo: Repo, id: string): { entry: PayloadEntry; full: string; body: string } {
  if (!/^p-[0-9a-f]{8}$/.test(id)) throw usage(`not a payload id: ${id}`);
  const entry = readJson<Record<string, PayloadEntry>>(indexPath(repo), {})[id];
  const file = repo.p("payloads", `${id}.md`);
  if (!entry || !fs.existsSync(file)) throw rejected(`unknown payload ${id}`);
  const full = fs.readFileSync(file, "utf8");
  const f = parseFrame(full);
  if (!f || f.id !== id || f.role !== entry.role || f.sha !== entry.sha256 || sha256(f.body) !== entry.sha256) {
    throw rejected(`payload ${id} failed its hash check (the frozen file was modified)`);
  }
  return { entry, full, body: f.body };
}

export function consumePayload(repo: Repo, id: string): void {
  withIndexLock(repo, (idx) => {
    if (!idx[id]) throw rejected(`unknown payload ${id}`);
    if (idx[id].consumed) throw rejected(`payload ${id} was already used; emit a new one`);
    idx[id].consumed = true;
    idx[id].consumed_at = nowIso();
  });
}

export function payloadIndex(repo: Repo): Record<string, PayloadEntry> {
  return readJson(indexPath(repo), {});
}

export function requireRole(entry: PayloadEntry, roles: Role[]): void {
  if (!roles.includes(entry.role)) throw new TcheckError(`payload ${entry.id} has role ${entry.role}; expected ${roles.join(" or ")}`, EXIT.REJECTED);
}
