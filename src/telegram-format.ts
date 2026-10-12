/**
 * Agents answer in Markdown; Telegram renders a small HTML subset (b, i, s, code, pre, a, blockquote).
 * Anything Telegram would still reject falls back to plain text at send time, so this favours readable over exhaustive.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const WEB_URL = /^https?:\/\//i;
const SLOT = '\u0000';

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

function inline(text: string): string {
  const slots: string[] = [];
  const keep = (html: string) => `${SLOT}${slots.push(html) - 1}${SLOT}`;
  return escapeHtml(
    text
      .replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`))
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, label: string, url: string) =>
        WEB_URL.test(url) ? keep(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`) : all,
      ),
  )
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '<b>$1</b>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/(?<![\p{L}\p{N}*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\p{L}\p{N}*])/gu, '<i>$1</i>')
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, '<i>$1</i>')
    .replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, 'g'), (_, i: string) => slots[Number(i)]);
}

/** About what fits across a phone in Telegram's monospace font; wider tables become one card per row. */
const PHONE_COLUMNS = 48;

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function table(rows: string[], separator: string): string {
  const right = cells(separator).map((c) => c.endsWith(':') && !c.startsWith(':'));
  const raw = rows.map(cells);
  const grid = raw.map((r) => r.map((c) => c.replace(/\*\*|__|~~|`/g, '')));
  const cols = Math.max(...grid.map((r) => r.length));
  const width = Array.from({ length: cols }, (_, i) => Math.max(...grid.map((r) => (r[i] ?? '').length)));
  if (width.reduce((a, b) => a + b, 0) + 3 * (cols - 1) > PHONE_COLUMNS) {
    const [header, ...body] = raw;
    return body
      .map((r) => [`<b>${inline(r[0] ?? '')}</b>`, ...r.slice(1).map((c, i) => `${inline(header[i + 1] ?? '')}: ${inline(c)}`)].join('\n'))
      .join('\n\n');
  }
  const line = (r: string[]) =>
    width
      .map((w, i) => (right[i] ? (r[i] ?? '').padStart(w) : (r[i] ?? '').padEnd(w)))
      .join(' | ')
      .trimEnd();
  const [head, ...body] = grid;
  return `<pre>${escapeHtml([line(head), width.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(line)].join('\n'))}</pre>`;
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.normalize('NFC').replaceAll(SLOT, '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      while (++i < lines.length && !(lines[i].trim().startsWith(fence[1][0].repeat(3)) && FENCE.exec(lines[i])?.[2] === '')) body.push(lines[i]);
      const code = escapeHtml(body.join('\n'));
      out.push(fence[2] ? `<pre><code class="language-${escapeAttr(fence[2])}">${code}</code></pre>` : `<pre>${code}</pre>`);
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      const separator = lines[i + 1];
      const rows = [line];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      out.push(table(rows, separator));
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(inline(QUOTE.exec(lines[i])![1]));
      i--;
      out.push(`<blockquote>${quoted.join('\n')}</blockquote>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) out.push(`<b>${inline(heading[1].replace(/\*\*|__/g, ''))}</b>`);
    else if (RULE.test(line)) out.push('──────────');
    else {
      const bullet = BULLET.exec(line);
      out.push(bullet ? `${bullet[1]}• ${inline(bullet[2])}` : inline(line));
    }
  }
  return out.join('\n');
}

/**
 * Cuts by code point so an emoji is never split into a lone surrogate. Every piece but the last is within one unit of
 * `limit`, so pieces of one line never share a part (and never get a line break between them).
 */
function cutLine(line: string, limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (cur.length + ch.length > limit) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Room kept in each part to close a code block that continues in the next part. */
const FENCE_RESERVE = 8;

/** Splits on line breaks into parts of at most `max` characters; a code block cut in two is closed and reopened. */
export function splitMarkdown(markdown: string, max: number): string[] {
  if (markdown.length <= max) return [markdown];
  const limit = max - FENCE_RESERVE;
  // A cut line fills whole parts, so its pieces never share a part (and never get a line break between them).
  const pieces = markdown.split('\n').flatMap((l) => (l.length <= limit ? [l] : cutLine(l, limit)));
  const parts: string[] = [];
  let lines: string[] = [];
  let size = 0;
  let openFence: string | undefined;
  for (const piece of pieces) {
    if (lines.length && size + 1 + piece.length > limit) {
      parts.push([...lines, ...(openFence ? ['```'] : [])].join('\n'));
      lines = openFence ? [openFence] : [];
      size = openFence?.length ?? 0;
    }
    size += (lines.length ? 1 : 0) + piece.length;
    lines.push(piece);
    if (FENCE.test(piece)) openFence = openFence ? undefined : piece.trim();
  }
  parts.push([...lines, ...(openFence ? ['```'] : [])].join('\n'));
  return parts;
}
