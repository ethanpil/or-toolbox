/**
 * The QA verdict for one result: every border pixel is exactly #FFFFFF and the product touches no edge, neither
 * of the square (a margin of 0) nor of the model's answer (cut off by the frame, or a background there that is
 * not white, so the product box reached it). Also the one line per photo that History keeps.
 */
import type { Box, IsolatedCheck } from '../../core/media/image';
import { plural } from '../../ui/format';

export interface QaReport {
  pass: boolean;
  /** Why it failed, one sentence each; empty when it passed. */
  reasons: string[];
  /** Something worth knowing that is not a failure (the threshold went lower for this photo), or null. */
  note: string | null;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
type Side = (typeof SIDES)[number];

/** The edges of the model's answer that the product box reaches. */
export function edgesReached(box: Box, source: { width: number; height: number }): Side[] {
  const reached: Record<Side, boolean> = {
    top: box.y <= 0,
    right: box.x + box.width >= source.width,
    bottom: box.y + box.height >= source.height,
    left: box.x <= 0,
  };
  return SIDES.filter((side) => reached[side]);
}

function list(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function qaReport(
  result: {
    check: IsolatedCheck;
    box: Box;
    threshold: number;
    /** The pipeline found no background to read and used the fixed threshold. */
    backgroundUnclear?: boolean;
    /** Border pixels of the exported JPG, decoded again, that are not exactly #FFFFFF. */
    encodedBorderFlaws?: number;
  },
  source: { width: number; height: number },
  wantedThreshold: number,
): QaReport {
  const reasons: string[] = [];
  const { check } = result;
  const are = (count: number): string => (count === 1 ? 'is' : 'are');
  if (!check.borderPureWhite) {
    reasons.push(
      `${plural(check.nonWhiteBorderPixels, 'border pixel')} ${are(check.nonWhiteBorderPixels)} not pure white.`,
    );
  }
  const flaws = result.encodedBorderFlaws ?? 0;
  if (flaws > 0) {
    reasons.push(
      `After JPG compression ${plural(flaws, 'border pixel')} ${are(flaws)} not pure white: export as PNG or use a larger margin.`,
    );
  }
  if (result.backgroundUnclear) {
    reasons.push(
      'The background could not be told apart at the edges of the edited photo, so the fixed threshold was used: check this one.',
    );
  }
  if (check.touchesEdge) reasons.push('The product touches the edge of the square.');
  const edges = edgesReached(result.box, source);
  if (edges.length === SIDES.length) {
    reasons.push(
      "The model's background is not white: nothing could be told apart from the product. Lower the threshold or retry with another model.",
    );
  } else if (edges.length > 0) {
    reasons.push(
      `The product reaches the ${list(edges)} ${edges.length === 1 ? 'edge' : 'edges'} of the edited photo: it may be cut off.`,
    );
  }
  const note =
    result.threshold < wantedThreshold
      ? `Filled from ${result.threshold} instead of ${wantedThreshold}, below this photo’s own background and its noise.`
      : null;
  return { pass: reasons.length === 0, reasons, note };
}

/** One line for History: `shoe.jpg: QA passed`, `…: QA failed: <reasons>` or `…: not isolated: <error>`. */
export function qaLine(name: string, report: QaReport | null, error: string | null): string {
  if (report) {
    return report.pass ? `${name}: QA passed` : `${name}: QA failed: ${report.reasons.join(' ')}`;
  }
  return `${name}: not isolated${error ? `: ${error}` : ''}`;
}
