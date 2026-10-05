/**
 * A deliberately small markdown reader for the legal texts. It knows exactly what the drafts use:
 * headings, paragraphs (a newline inside a paragraph is a line break, which is what the address
 * block needs), bullet and numbered lists, pipe tables, `[links](url)`, **bold**, *italic*, `code`
 * and backslash escapes. It produces data, never HTML: the React side turns the nodes into elements,
 * so there is nothing to sanitise and no raw HTML is ever injected.
 */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; text: string; href: string };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3 | 4; inline: Inline[] }
  | { t: 'p'; lines: Inline[][] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

const INLINE = /\\([\\`*_{}[\]()#+\-.!|<>])|`([^`]+)`|\*\*((?:[^*]|\*(?!\*))+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (v: string) => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev?.t === 'text') prev.v += v;
    else out.push({ t: 'text', v });
  };
  for (const m of src.matchAll(INLINE)) {
    push(src.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) push(m[1]);
    else if (m[2] !== undefined) out.push({ t: 'code', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'strong', children: parseInline(m[3]) });
    else if (m[4] !== undefined) out.push({ t: 'em', children: parseInline(m[4]) });
    else out.push({ t: 'link', text: m[5], href: m[6] });
  }
  push(src.slice(last));
  return out;
}

/** Only these targets become links. Anything else (javascript:, data:, ...) is shown as plain text. */
export function isSafeHref(href: string): boolean {
  return /^\/(?!\/)/.test(href) || /^https:\/\/[^\s]+$/.test(href) || /^mailto:[^\s]+$/.test(href);
}

const splitRow = (line: string): string[] => {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') { cur += '\\|'; i++; }
    else if (line[i] === '|') { cells.push(cur); cur = ''; }
    else cur += line[i];
  }
  cells.push(cur);
  if (cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
};

const isTableSep = (line: string | undefined) => !!line && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', lines: para.map(parseInline) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { flush(); continue; }

    const h = /^(#{1,4})\s+(.*\S)\s*$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3 | 4, inline: parseInline(h[2]) }); continue; }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }

    if (line.trimStart().startsWith('|') && isTableSep(lines[i + 1])) {
      flush();
      const head = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trimStart().startsWith('|')) rows.push(splitRow(lines[i++]).map(parseInline));
      i--;
      blocks.push({ t: 'table', head, rows });
      continue;
    }

    const li = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const kind = li[1] ? 'ul' : 'ol';
      const items: Inline[][] = [];
      let cur = li[3];
      while (true) {
        const next = lines[i + 1];
        const m = next === undefined ? null : /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(next);
        if (m && !!m[1] === !!li[1]) { items.push(parseInline(cur)); cur = m[3]; i++; }
        else if (next !== undefined && /^\s{2,}\S/.test(next)) { cur += ' ' + next.trim(); i++; }
        else break;
      }
      items.push(parseInline(cur));
      blocks.push({ t: kind, items });
      continue;
    }

    para.push(line.trim());
  }
  flush();
  return blocks;
}
