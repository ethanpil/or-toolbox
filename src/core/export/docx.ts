/**
 * Word documents (.docx) from Markdown, through `marked` (to read the
 * Markdown) and `docx` (to write the file), both loaded on use.
 *
 * Supported: headings 1-6, paragraphs with bold, italic, strikethrough, inline
 * code and links (http, https and mailto only), ordered and unordered lists
 * with nesting and task boxes, tables (GFM, with column alignment), fenced
 * code blocks, block quotes and horizontal rules. Images are replaced by their
 * alt text, raw HTML by its text, because the text is untrusted model output
 * and nothing in the file may load anything.
 */
import type * as DocxModule from 'docx';
import type {
  ILevelsOptions,
  INumberingOptions,
  IParagraphOptions,
  ParagraphChild,
  Paragraph as DocxParagraph,
  Table as DocxTable,
} from 'docx';
import type { Token, Tokens } from 'marked';
import { stripIllegalXml } from './xml';

type Docx = typeof DocxModule;

interface Style {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

interface Context {
  docx: Docx;
  /** Hands out a fresh numbering instance, so every ordered list counts from 1. */
  nextInstance: () => number;
  /** Block quotes indent and get a left rule. */
  quoted: boolean;
}

const MONOSPACE = 'Consolas';
const CODE_SHADING = 'F3F4F6';
const SAFE_LINK = /^(https?:|mailto:)/i;

/** The character for a numeric reference, or U+FFFD where none exists (too large, or a surrogate). */
function fromReference(code: number): string {
  const valid =
    Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return valid ? String.fromCodePoint(code) : String.fromCharCode(0xfffd);
}

/**
 * marked leaves HTML entities in text tokens; Word wants the characters. A
 * reference to a character that cannot exist (`&#99999999;`) becomes U+FFFD;
 * one to a control character (`&#1;`) is decoded here and removed later, with
 * every other control character, when the text goes into the document.
 */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => fromReference(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => fromReference(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return unescapeHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim();
}

/** Text runs for `text`, one per line, with the characters XML cannot hold removed. */
function run(context: Context, text: string, style: Style): ParagraphChild[] {
  const { TextRun } = context.docx;
  const parts = stripIllegalXml(text).split('\n');
  return parts.map(
    (part, index) =>
      new TextRun({
        text: part,
        ...(index > 0 ? { break: 1 } : {}),
        ...(style.bold ? { bold: true } : {}),
        ...(style.italics ? { italics: true } : {}),
        ...(style.strike ? { strike: true } : {}),
        ...(style.code
          ? {
              font: MONOSPACE,
              shading: { type: 'clear' as const, fill: CODE_SHADING, color: 'auto' },
            }
          : {}),
        ...(style.link ? { color: '0563C1', underline: { type: 'single' as const } } : {}),
      }),
  );
}

/** Inline tokens as Word runs. */
function inline(
  context: Context,
  tokens: readonly Token[] | undefined,
  style: Style = {},
): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        children.push(
          ...inline(context, (token as Tokens.Strong).tokens, { ...style, bold: true }),
        );
        break;
      case 'em':
        children.push(...inline(context, (token as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case 'del':
        children.push(...inline(context, (token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        children.push(
          ...run(context, unescapeHtml((token as Tokens.Codespan).text), { ...style, code: true }),
        );
        break;
      case 'br':
        children.push(new context.docx.TextRun({ break: 1 }));
        break;
      case 'link': {
        const link = token as Tokens.Link;
        const href = stripIllegalXml(link.href);
        if (SAFE_LINK.test(href)) {
          children.push(
            new context.docx.ExternalHyperlink({
              link: href,
              children: inline(context, link.tokens, { ...style, link: true }),
            }),
          );
        } else {
          children.push(...inline(context, link.tokens, style));
        }
        break;
      }
      case 'image':
        children.push(
          ...run(context, `[image: ${unescapeHtml((token as Tokens.Image).text)}]`, style),
        );
        break;
      case 'html': {
        const html = (token as Tokens.HTML).text;
        if (/^<br\s*\/?>$/i.test(html.trim()))
          children.push(new context.docx.TextRun({ break: 1 }));
        break;
      }
      default: {
        // text, escape: plain text, possibly with nested inline tokens.
        const text = token as Tokens.Text;
        if (text.tokens?.length) children.push(...inline(context, text.tokens, style));
        else children.push(...run(context, unescapeHtml(text.text).replace(/\n/g, ' '), style));
      }
    }
  }
  return children;
}

/** Options shared by every paragraph in the current context. */
function base(context: Context): Partial<IParagraphOptions> {
  const { BorderStyle } = context.docx;
  return context.quoted
    ? {
        indent: { left: 720 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, space: 8, color: 'AAAAAA' } },
      }
    : {};
}

function heading(context: Context, level: number): IParagraphOptions['heading'] {
  const { HeadingLevel } = context.docx;
  const levels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];
  return levels[Math.min(5, Math.max(0, level - 1))];
}

type Block = DocxParagraph | DocxTable;

function list(context: Context, token: Tokens.List, level: number): Block[] {
  const blocks: Block[] = [];
  const instance = token.ordered ? context.nextInstance() : undefined;
  for (const item of token.items) {
    const content = item.tokens.find(
      (child) => child.type === 'text' || child.type === 'paragraph',
    ) as Tokens.Text | Tokens.Paragraph | undefined;
    const children = inline(context, content?.tokens ?? [], {});
    if (item.task) children.unshift(...run(context, item.checked ? '☑ ' : '☐ ', {}));
    blocks.push(
      new context.docx.Paragraph({
        ...base(context),
        children,
        numbering: {
          reference: token.ordered ? 'ordered' : 'bullets',
          level: Math.min(level, 5),
          ...(instance === undefined ? {} : { instance }),
        },
      }),
    );
    for (const child of item.tokens) {
      if (child === content) continue;
      if (child.type === 'list') blocks.push(...list(context, child as Tokens.List, level + 1));
      else blocks.push(...block(context, [child]));
    }
  }
  return blocks;
}

function table(context: Context, token: Tokens.Table): DocxTable {
  const { Table, TableRow, TableCell, Paragraph, WidthType, ShadingType, AlignmentType } =
    context.docx;
  const columns = Math.max(1, token.header.length);
  const width = Math.floor(9000 / columns);
  const alignment = (
    index: number,
  ): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined => {
    const align = token.align[index];
    return align === 'center'
      ? AlignmentType.CENTER
      : align === 'right'
        ? AlignmentType.RIGHT
        : undefined;
  };
  const row = (cells: Tokens.TableCell[], header: boolean): InstanceType<Docx['TableRow']> =>
    new TableRow({
      tableHeader: header,
      children: cells.map(
        (cell, index) =>
          new TableCell({
            width: { size: width, type: WidthType.DXA },
            ...(header
              ? { shading: { type: ShadingType.CLEAR, fill: CODE_SHADING, color: 'auto' } }
              : {}),
            children: [
              new Paragraph({
                children: inline(context, cell.tokens, header ? { bold: true } : {}),
                ...(alignment(index) ? { alignment: alignment(index) } : {}),
              }),
            ],
          }),
      ),
    });
  return new Table({
    width: { size: columns * width, type: WidthType.DXA },
    columnWidths: Array.from({ length: columns }, () => width),
    rows: [row(token.header, true), ...token.rows.map((cells) => row(cells, false))],
  });
}

/** Block tokens as Word paragraphs and tables. */
function block(context: Context, tokens: readonly Token[]): Block[] {
  const { Paragraph, TextRun, BorderStyle } = context.docx;
  const blocks: Block[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const { depth, tokens: children } = token as Tokens.Heading;
        blocks.push(
          new Paragraph({
            ...base(context),
            heading: heading(context, depth),
            children: inline(context, children),
          }),
        );
        break;
      }
      case 'paragraph':
      case 'text': {
        const { tokens: children, text } = token as Tokens.Paragraph;
        blocks.push(
          new Paragraph({
            ...base(context),
            spacing: { after: 120 },
            children: children?.length
              ? inline(context, children)
              : run(context, unescapeHtml(text), {}),
          }),
        );
        break;
      }
      case 'list':
        blocks.push(...list(context, token as Tokens.List, 0));
        break;
      case 'table':
        blocks.push(table(context, token as Tokens.Table));
        blocks.push(new Paragraph({ children: [] }));
        break;
      case 'code': {
        const lines = stripIllegalXml((token as Tokens.Code).text.replace(/\r\n?/g, '\n')).split(
          '\n',
        );
        blocks.push(
          new Paragraph({
            ...base(context),
            shading: { type: 'clear', fill: CODE_SHADING, color: 'auto' },
            spacing: { after: 120 },
            children: lines.map(
              (line, index) =>
                new TextRun({
                  text: line,
                  font: MONOSPACE,
                  size: 19,
                  ...(index > 0 ? { break: 1 } : {}),
                }),
            ),
          }),
        );
        break;
      }
      case 'blockquote':
        blocks.push(...block({ ...context, quoted: true }, (token as Tokens.Blockquote).tokens));
        break;
      case 'hr':
        blocks.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: 'AAAAAA' } },
          }),
        );
        break;
      case 'html': {
        const text = stripTags((token as Tokens.HTML).text);
        if (text)
          blocks.push(new Paragraph({ ...base(context), children: run(context, text, {}) }));
        break;
      }
      default:
        break; // space, def, ...
    }
  }
  return blocks;
}

/** Numbering definitions: bullets and decimal lists, six levels deep. */
function numbering(docx: Docx): INumberingOptions {
  const { LevelFormat, AlignmentType } = docx;
  const bulletMarks = ['•', '◦', '▪'];
  const orderedFormats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  const level = (
    format: ILevelsOptions['format'],
    text: string,
    index: number,
  ): ILevelsOptions => ({
    level: index,
    format,
    text,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (index + 1), hanging: 360 } } },
  });
  const levels = [0, 1, 2, 3, 4, 5];
  return {
    config: [
      {
        reference: 'bullets',
        levels: levels.map((index) =>
          level(LevelFormat.BULLET, bulletMarks[index % 3] ?? '•', index),
        ),
      },
      {
        reference: 'ordered',
        levels: levels.map((index) =>
          level(orderedFormats[index % 3] ?? LevelFormat.DECIMAL, `%${index + 1}.`, index),
        ),
      },
    ],
  };
}

/** Converts Markdown to a Word document. */
export async function toDocx(markdown: string): Promise<Blob> {
  const [docx, { Lexer }] = await Promise.all([import('docx'), import('marked')]);
  const tokens = new Lexer({ gfm: true }).lex(markdown);
  let instances = 0;
  const children = block({ docx, nextInstance: () => ++instances, quoted: false }, tokens);
  const document = new docx.Document({
    creator: 'ORtoolbox',
    numbering: numbering(docx),
    sections: [{ children: children.length ? children : [new docx.Paragraph({ children: [] })] }],
  });
  return docx.Packer.toBlob(document);
}
