// @vitest-environment node
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { toDocx, unescapeHtml } from './docx';

const MARKDOWN = `# Title

Some **bold**, *italic*, \`code\`, ~~gone~~ text, AT&T <3, a [link](https://example.com) and an [evil](javascript:alert(1)).

1. First
2. Second
   - nested bullet

- Bullet A
- [x] Done

1. Again from one

| Name | Qty |
| :--- | ---: |
| Tom & Jerry | 2 |

\`\`\`js
const a = 1 < 2;
  indented();
\`\`\`

> quoted

---
`;

async function open(blob: Blob): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
}

/** The `<w:r>` run that contains `text`. */
function runWith(xml: string, text: string): string {
  const run = xml.split('<w:r>').find((part) => part.includes(`>${text}<`));
  if (!run) throw new Error(`no run with ${text}`);
  return run;
}

describe('unescapeHtml', () => {
  it('undoes the entities marked leaves in text', () => {
    expect(unescapeHtml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;')).toBe(
      'a & b <c> "d" \'e\' A',
    );
    expect(unescapeHtml('&amp;lt;')).toBe('&lt;'); // one level only
  });
});

describe('toDocx', () => {
  let files: Record<string, string>;
  let xml: string;

  beforeAll(async () => {
    const blob = await toDocx(MARKDOWN);
    expect(blob.type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    files = await open(blob);
    xml = files['word/document.xml'] ?? '';
  });

  it('writes a Word package', () => {
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'word/document.xml', 'word/numbering.xml']),
    );
  });

  it('makes headings', () => {
    expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/>/);
    expect(xml).toContain('>Title<');
  });

  it('styles inline runs', () => {
    expect(runWith(xml, 'bold')).toMatch(/<w:b\/>/);
    expect(runWith(xml, 'italic')).toMatch(/<w:i\/>/);
    expect(runWith(xml, 'gone')).toMatch(/<w:strike\/>/);
    expect(runWith(xml, 'code')).toContain('Consolas');
  });

  it('turns entities back into characters, and lets the XML layer escape them', () => {
    expect(xml).toContain('AT&amp;T &lt;3');
    expect(xml).toContain('Tom &amp; Jerry');
    expect(xml).not.toContain('&amp;amp;');
  });

  it('links only to http, https and mailto', () => {
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(1);
    expect(files['word/_rels/document.xml.rels']).toContain('Target="https://example.com"');
    expect(Object.values(files).some((content) => content.includes('javascript:'))).toBe(false);
    expect(xml).toContain('>evil<'); // the text stays
  });

  it('makes bulleted and numbered lists, nested, with a fresh count for each numbered list', () => {
    const numbered = [
      ...xml.matchAll(/<w:numPr><w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/><\/w:numPr>/g),
    ];
    expect(numbered).toHaveLength(6); // First, Second, nested, Bullet A, Done, Again
    const levels = numbered.map((match) => match[1]);
    expect(levels).toEqual(['0', '0', '1', '0', '0', '0']);
    const ids = numbered.map((match) => match[2]);
    expect(ids[0]).toBe(ids[1]); // same list
    expect(ids[5]).not.toBe(ids[0]); // second numbered list restarts
    expect(new Set(ids).size).toBe(3); // two numbered lists + the bullets
    expect(xml).toContain('☑ '); // the task box
  });

  it('builds a table with a shaded header and aligned columns', () => {
    expect(xml).toContain('<w:tbl>');
    expect(runWith(xml, 'Name')).toMatch(/<w:b\/>/);
    expect(xml).toContain('w:fill="F3F4F6"');
    expect(xml).toMatch(/<w:jc w:val="right"\/>/);
    expect(xml).toContain('>2<');
  });

  it('keeps code blocks in a monospaced font with line breaks and spaces', () => {
    expect(xml).toContain('const a = 1 &lt; 2;');
    expect(xml).toMatch(/xml:space="preserve">\s{2}indented\(\);</);
    expect(xml).toContain('<w:br/>');
  });

  it('marks block quotes and rules', () => {
    expect(runWith(xml, 'quoted')).toBeTruthy();
    expect(xml).toMatch(/<w:pBdr><w:left /);
    expect(xml).toMatch(/<w:pBdr><w:bottom /);
  });

  it('still writes a valid document for empty input and drops raw HTML', async () => {
    expect((await open(await toDocx('')))['word/document.xml']).toContain('<w:body>');
    const html =
      (await open(await toDocx('<script>alert(1)</script>\n\n<b>bold</b> text')))[
        'word/document.xml'
      ] ?? '';
    expect(html).not.toContain('<script');
    expect(html).toContain('alert(1)'); // as text, never markup
  });
});
