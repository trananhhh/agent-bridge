import { describe, expect, it } from 'vitest';
import { markdownToTelegramHtml, splitMarkdown } from './telegram-format.ts';

const html = (lines: string[]) => markdownToTelegramHtml(lines.join('\n'));

describe('markdownToTelegramHtml', () => {
  it('escapes HTML and renders inline bold, italic, strike and code', () => {
    expect(markdownToTelegramHtml('a < b & **c** _d_ *e* ~~f~~ `<x> **y**`')).toBe(
      'a &lt; b &amp; <b>c</b> <i>d</i> <i>e</i> <s>f</s> <code>&lt;x&gt; **y**</code>',
    );
  });

  it('leaves underscores and asterisks inside words and arithmetic alone', () => {
    expect(markdownToTelegramHtml('snake_case_name, 2*3*4 and 5 * 6')).toBe('snake_case_name, 2*3*4 and 5 * 6');
  });

  it('turns headings bold, bullets into dots and rules into a line', () => {
    expect(html(['## Kết quả', '- một', '  * hai', '1. ba', '---', 'xong'])).toBe(
      ['<b>Kết quả</b>', '• một', '  • hai', '1. ba', '──────────', 'xong'].join('\n'),
    );
  });

  it('keeps fenced code verbatim, with its language when given', () => {
    expect(html(['```ts', 'const a = 1 < 2; // **no**', '```', '```', 'x', '```'])).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2; // **no**</code></pre>\n<pre>x</pre>',
    );
  });

  it('lays tables out as aligned monospace, honouring right alignment', () => {
    expect(html(['Bảng:', '| Hạng mục | Số tiền |', '|---|---:|', '| **Lãi T9** | 8.519.298 |', '| Quỹ | 17.388.163 |', 'hết'])).toBe(
      ['Bảng:', '<pre>Hạng mục |    Số tiền', '---------+-----------', 'Lãi T9   |  8.519.298', 'Quỹ      | 17.388.163</pre>', 'hết'].join('\n'),
    );
  });

  it('turns a table too wide for a phone into one card per row', () => {
    expect(
      html([
        '| # | Đề xuất | Đối chiếu |',
        '|---|---|---|',
        '| 1 | Chia đôi lãi từ **01/09** liên tục theo tháng | Khớp với chốt hôm 11/10 |',
        '| 2 | Bỏ 150tr | Chưa có ghi chép |',
      ]),
    ).toBe(
      ['<b>1</b>', 'Đề xuất: Chia đôi lãi từ <b>01/09</b> liên tục theo tháng', 'Đối chiếu: Khớp với chốt hôm 11/10', '', '<b>2</b>', 'Đề xuất: Bỏ 150tr', 'Đối chiếu: Chưa có ghi chép'].join(
        '\n',
      ),
    );
  });

  it('wraps quotes and renders only web links', () => {
    expect(html(['> chú ý', '> dòng **2**', '[bảng](https://x.vn/a?b=1&c=2) [x](javascript:alert(1)) [y](tg://resolve?domain=z)'])).toBe(
      '<blockquote>chú ý\ndòng <b>2</b></blockquote>\n<a href="https://x.vn/a?b=1&amp;c=2">bảng</a> [x](javascript:alert(1)) [y](tg://resolve?domain=z)',
    );
  });
});

describe('splitMarkdown', () => {
  it('never exceeds the limit and closes a code block cut in two, reopening it in the next part', () => {
    const parts = splitMarkdown(['intro', '```sql', 'select 1;', 'select 2;', '```', 'end'].join('\n'), 30);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 30)).toBe(true);
    for (const p of parts) expect(p.split('\n').filter((l) => l.startsWith('```')).length % 2).toBe(0);
    expect(parts.join('\n')).toContain('select 2;');
  });

  it('cuts a line longer than a whole part', () => {
    const parts = splitMarkdown('x'.repeat(100), 40);
    expect(parts.join('')).toBe('x'.repeat(100));
    expect(parts.every((p) => p.length <= 40)).toBe(true);
  });

  it('never cuts an emoji in half', () => {
    const parts = splitMarkdown(`a${'😀'.repeat(60)}`, 40);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.some((p) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p))).toBe(false);
    expect(parts.join('')).toBe(`a${'😀'.repeat(60)}`);
  });

  it('leaves short text whole', () => {
    expect(splitMarkdown('short', 100)).toEqual(['short']);
  });
});
