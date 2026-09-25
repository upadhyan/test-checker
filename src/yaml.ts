/**
 * Minimal YAML subset parser: block mappings and sequences, flow `[a, b]` / `{a: b}`,
 * quoted and plain scalars, `|` / `>` block scalars, and comments.
 * Enough for .test-checker/config.yaml, fixture.yaml and the examples.
 * ponytail: no anchors, tags or multi-document streams; vendor a full parser if configs ever need them.
 */

interface Line {
  indent: number;
  text: string;
  no: number;
}

export class YamlError extends Error {}

export function parseYaml(src: string): any {
  const lines: Line[] = [];
  src.replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
    const text = stripComment(raw).trimEnd();
    if (text.trim() === "" || text.trim() === "---") return;
    lines.push({ indent: raw.length - raw.trimStart().length, text: text.trim(), no: i + 1 });
  });
  // Block scalars need the raw lines, so keep them around.
  const rawLines = src.replace(/\r\n?/g, "\n").split("\n");
  let pos = 0;

  function parseBlock(indent: number): any {
    if (pos >= lines.length) return null;
    return lines[pos].text.startsWith("- ") || lines[pos].text === "-" ? parseSeq(lines[pos].indent) : parseMap(lines[pos].indent);
  }

  function parseSeq(indent: number): any[] {
    const out: any[] = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith("- ") || lines[pos].text === "-")) {
      const line = lines[pos];
      const rest = line.text === "-" ? "" : line.text.slice(2).trim();
      pos++;
      if (rest === "") {
        out.push(pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null);
      } else if (isMapEntry(rest)) {
        // "- key: value" starts an inline mapping whose further keys are indented past the dash.
        const childIndent = indent + 2;
        lines.splice(pos, 0, { indent: childIndent, text: rest, no: line.no });
        out.push(parseMap(childIndent));
      } else out.push(scalar(rest, line.no));
    }
    return out;
  }

  function parseMap(indent: number): Record<string, any> {
    const out: Record<string, any> = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      if (line.text.startsWith("- ")) throw new YamlError(`line ${line.no}: unexpected sequence item`);
      const m = splitKey(line.text);
      if (!m) throw new YamlError(`line ${line.no}: expected "key: value"`);
      const [key, rest] = m;
      pos++;
      if (rest === "|" || rest === ">" || /^[|>][-+]?$/.test(rest)) {
        out[key] = blockScalar(line, rest[0] === ">");
      } else if (rest === "") {
        if (pos < lines.length && lines[pos].indent > indent) out[key] = parseBlock(lines[pos].indent);
        else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("- ")) out[key] = parseSeq(indent);
        else out[key] = null;
      } else out[key] = scalar(rest, line.no);
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError(`line ${lines[pos].no}: bad indentation`);
    return out;
  }

  function blockScalar(header: Line, fold: boolean): string {
    const body: string[] = [];
    let i = header.no; // raw index of the next line
    let blockIndent = -1;
    while (i < rawLines.length) {
      const raw = rawLines[i];
      if (raw.trim() === "") {
        body.push("");
        i++;
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (blockIndent < 0) blockIndent = ind;
      if (ind < blockIndent || ind <= header.indent) break;
      body.push(raw.slice(blockIndent));
      i++;
    }
    while (pos < lines.length && lines[pos].no <= i) pos++;
    while (body.length && body[body.length - 1] === "") body.pop();
    return (fold ? body.join(" ").replace(/ {2,}/g, " ") : body.join("\n")) + "\n";
  }

  const result = parseBlock(0);
  if (pos < lines.length) throw new YamlError(`line ${lines[pos].no}: unexpected content`);
  return result ?? {};
}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function isMapEntry(s: string): boolean {
  return splitKey(s) !== null && !/^["'[{]/.test(s);
}

function splitKey(s: string): [string, string] | null {
  if (s[0] === '"' || s[0] === "'") {
    const end = s.indexOf(s[0], 1);
    if (end > 0 && s[end + 1] === ":") return [s.slice(1, end), s.slice(end + 2).trim()];
    return null;
  }
  const m = /^([^:[\]{}]+?):(?:\s+(.*))?$/.exec(s);
  return m ? [m[1].trim(), (m[2] ?? "").trim()] : null;
}

function scalar(s: string, no: number): any {
  if (s.startsWith("[") || s.startsWith("{")) {
    const [v, rest] = flow(s, 0, no);
    if (s.slice(rest).trim()) throw new YamlError(`line ${no}: trailing content after flow value`);
    return v;
  }
  return plain(s, no);
}

function plain(s: string, no: number): any {
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlError(`line ${no}: bad double-quoted string`);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(`line ${no}: bad single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function flow(s: string, i: number, no: number): [any, number] {
  const skip = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  skip();
  if (s[i] === "[" || s[i] === "{") {
    const isMap = s[i] === "{";
    const close = isMap ? "}" : "]";
    i++;
    const arr: any[] = [];
    const obj: Record<string, any> = {};
    skip();
    if (s[i] === close) return [isMap ? obj : arr, i + 1];
    for (;;) {
      if (isMap) {
        const [k, j] = flowScalar(s, i, ":", no);
        i = j + 1;
        const [v, j2] = flow(s, i, no);
        obj[k] = v;
        i = j2;
      } else {
        const [v, j] = flow(s, i, no);
        arr.push(v);
        i = j;
      }
      skip();
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === close) return [isMap ? obj : arr, i + 1];
      throw new YamlError(`line ${no}: bad flow collection`);
    }
  }
  const [raw, j] = flowScalar(s, i, ",]}", no);
  return [plain(raw, no), j];
}

function flowScalar(s: string, i: number, stops: string, no: number): [string, number] {
  while (/\s/.test(s[i] ?? "")) i++;
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i];
    let j = i + 1;
    while (j < s.length && s[j] !== q) j += s[j] === "\\" && q === '"' ? 2 : 1;
    if (j >= s.length) throw new YamlError(`line ${no}: unterminated string`);
    const raw = s.slice(i, j + 1);
    return [stops === ":" ? String(plain(raw, no)) : raw, j + 1];
  }
  let j = i;
  while (j < s.length && !stops.includes(s[j])) j++;
  return [s.slice(i, j).trim(), j];
}
