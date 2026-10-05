// @vitest-environment node
/**
 * UI text uses US spelling. This reads the text a person can see or hear (see
 * us-spelling.ts for exactly where) and fails on a British spelling such as
 * "colour" or "summarise". Fix the text; if the literal is not UI text, add it
 * to ALLOWED in us-spelling.ts with the reason.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED,
  describeFinding,
  findBritish,
  htmlEntries,
  isAllowed,
  literalTexts,
  manifestFiles,
  scanHtmlTitles,
  scanManifests,
  scanTypeScript,
  sourceFiles,
  ROOT,
} from './us-spelling.ts';
import { join } from 'node:path';

const unallowed = (findings: ReturnType<typeof scanTypeScript>): string[] =>
  findings.filter((finding) => !isAllowed(finding)).map(describeFinding);

describe('UI text uses US spelling', () => {
  it('has no British spelling in the string literals of src/', { timeout: 60_000 }, () => {
    expect(sourceFiles(join(ROOT, 'src')).length).toBeGreaterThan(200);
    expect(unallowed(scanTypeScript())).toEqual([]);
  });

  it('has no British spelling in the HTML titles', () => {
    expect(htmlEntries().length).toBeGreaterThan(20);
    expect(unallowed(scanHtmlTitles())).toEqual([]);
  });

  it('has no British spelling in the tool and web app manifests', () => {
    expect(manifestFiles().length).toBeGreaterThan(14);
    expect(unallowed(scanManifests())).toEqual([]);
  });

  it('keeps no allowed exception that no longer matches anything', { timeout: 60_000 }, () => {
    const findings = scanTypeScript();
    const stale = ALLOWED.filter(
      (entry) =>
        !findings.some(
          (finding) =>
            finding.file === entry.file &&
            finding.word === entry.word &&
            (entry.text === undefined || entry.text === finding.text),
        ),
    );
    expect(stale).toEqual([]);
  });

  it('gives every exception a reason', () => {
    expect(ALLOWED.filter((entry) => entry.reason.trim() === '')).toEqual([]);
  });
});

describe('the check itself', () => {
  const hits = (code: string): string[] =>
    literalTexts('planted.ts', code).flatMap(({ text }) => findBritish(text));

  it.each([
    ["h('p', null, 'Choose a colour')", 'colour'],
    ["announce('Accent colours reset.')", 'colours'],
    ['toast(`Run cancelled after ${n} steps`)', 'cancelled'],
    ["const a = 'Summarise the page'", 'summarise'],
    ["const a = 'Document organisation'", 'organisation'],
    ["const a = 'Analyse the image'", 'analyse'],
    ["const a = 'Recognised speakers'", 'recognised'],
    ["const a = 'A centred panel'", 'centred'],
    ["const a = 'Greyscale'", 'greyscale'],
    ["const a = 'Model catalogue'", 'catalogue'],
    ["const a = 'This behaviour is not licenced'", 'behaviour'],
    ["const a = 'Labelled and modelled'", 'labelled'],
    ["const a = 'Fulfil the request'", 'fulfil'],
    ["const a = 'See the favourites'", 'favourites'],
    ["const a = 'Used whilst running'", 'whilst'],
  ])('catches %s', (code, word) => {
    expect(hits(code)).toContain(word);
  });

  it('reads template-literal text on both sides of a substitution', () => {
    expect(hits('const a = `${x} grey ${y} colour`;')).toEqual(['grey', 'colour']);
  });

  it('ignores comments, identifiers, regular expressions, module paths and literal types', () => {
    const code = [
      '// the colour of a label',
      '/** Summarise the neighbour. */',
      'const parseColour = (colour: string) => colour;',
      'const re = /cancelled|colour/;',
      "import './grey.scss';",
      "type State = 'cancelled' | 'running';",
      "export * from './colour';",
    ].join('\n');
    expect(hits(code)).toEqual([]);
  });

  it.each([
    'Accent color',
    'The run was canceled',
    'Summarize and organize',
    'Recognized, normalized, analyzed',
    'A centered, labeled panel',
    'Gray background',
    'Model catalog',
    'Your neighbor’s behavior',
    'otherwise, promise, advise, revise, exercise, surprise, enterprise, premises, sunrise',
    'compromise, precise, concise, raise, noise, rising, praise, supervised, analyses',
    'a counterclockwise turn, your hour, the four sources',
    'Denise, installed, spelled, billing, filled',
  ])('leaves US spelling alone: %s', (text) => {
    expect(findBritish(text)).toEqual([]);
  });
});
