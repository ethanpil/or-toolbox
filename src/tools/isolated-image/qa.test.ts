// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { edgesReached, qaLine, qaReport } from './qa';

const clean = { borderPureWhite: true, touchesEdge: false, nonWhiteBorderPixels: 0 };
const source = { width: 100, height: 80 };
const inside = { x: 10, y: 10, width: 50, height: 40 };

describe('qaReport', () => {
  it('passes a pure white border with the product clear of every edge', () => {
    expect(qaReport({ check: clean, box: inside, threshold: 245 }, source, 245)).toEqual({
      pass: true,
      reasons: [],
      note: null,
    });
  });

  it('names each failure', () => {
    const report = qaReport(
      {
        check: { borderPureWhite: false, touchesEdge: true, nonWhiteBorderPixels: 12 },
        box: inside,
        threshold: 245,
      },
      source,
      245,
    );
    expect(report.pass).toBe(false);
    expect(report.reasons).toEqual([
      '12 border pixels are not pure white.',
      'The product touches the edge of the square.',
    ]);
    const one = qaReport(
      {
        check: { ...clean, borderPureWhite: false, nonWhiteBorderPixels: 1 },
        box: inside,
        threshold: 245,
      },
      source,
      245,
    );
    expect(one.reasons).toEqual(['1 border pixel is not pure white.']);
  });

  it('fails a product that reaches the edges of the model’s picture', () => {
    const cut = qaReport(
      { check: clean, box: { x: 0, y: 10, width: 50, height: 70 }, threshold: 245 },
      source,
      245,
    );
    expect(cut.reasons).toEqual([
      'The product reaches the bottom and left edges of the edited photo: it may be cut off.',
    ]);
    const everywhere = qaReport(
      { check: clean, box: { x: 0, y: 0, width: 100, height: 80 }, threshold: 245 },
      source,
      245,
    );
    expect(everywhere.reasons[0]).toContain("The model's background is not white");
  });

  it('checks the exported file: a JPG whose decoded border is not pure white fails', () => {
    const report = qaReport(
      { check: clean, box: inside, threshold: 245, encodedBorderFlaws: 35 },
      source,
      245,
    );
    expect(report.pass).toBe(false);
    expect(report.reasons).toEqual([
      'After JPG compression 35 border pixels are not pure white: export as PNG or use a larger margin.',
    ]);
    expect(
      qaReport({ check: clean, box: inside, threshold: 245, encodedBorderFlaws: 0 }, source, 245)
        .pass,
    ).toBe(true);
  });

  it('asks for a look when the background could not be read', () => {
    const report = qaReport(
      { check: clean, box: inside, threshold: 245, backgroundUnclear: true },
      source,
      245,
    );
    expect(report.pass).toBe(false);
    expect(report.reasons).toEqual([
      'The background could not be told apart at the edges of the edited photo, so the fixed threshold was used: check this one.',
    ]);
  });

  it('notes a threshold that went lower for this photo without failing it', () => {
    const report = qaReport({ check: clean, box: inside, threshold: 231 }, source, 245);
    expect(report.pass).toBe(true);
    expect(report.note).toBe(
      'Filled from 231 instead of 245, below this photo’s own background and its noise.',
    );
  });
});

describe('edgesReached', () => {
  it('lists the sides in order', () => {
    expect(edgesReached({ x: 0, y: 0, width: 100, height: 80 }, source)).toEqual([
      'top',
      'right',
      'bottom',
      'left',
    ]);
    expect(edgesReached({ x: 50, y: 1, width: 50, height: 10 }, source)).toEqual(['right']);
  });
});

describe('qaLine', () => {
  it('is one History line per photo', () => {
    expect(qaLine('a.png', { pass: true, reasons: [], note: null }, null)).toBe('a.png: QA passed');
    expect(qaLine('b.png', { pass: false, reasons: ['One.', 'Two.'], note: null }, null)).toBe(
      'b.png: QA failed: One. Two.',
    );
    expect(qaLine('c.png', null, 'Mocked error 502')).toBe('c.png: not isolated: Mocked error 502');
    expect(qaLine('d.png', null, null)).toBe('d.png: not isolated');
  });
});
