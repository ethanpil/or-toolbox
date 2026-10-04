/**
 * A video's frame rate, read from its MP4/MOV boxes (no decoding, no ffmpeg): the video track's `mdhd` timescale
 * over its most common `stts` sample duration. Only the box headers are read until `moov`, then `moov` itself, so a
 * large file costs a few small reads. Anything else (WebM, a damaged file) gets `DEFAULT_FPS`.
 */

/** Used when the frame rate cannot be read. */
export const DEFAULT_FPS = 30;
/** `moov` larger than this is not read (it would be a very long or unusual file). */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

interface Box {
  type: string;
  /** Offset of the box's content (after its header) and the end of the box, within the buffer read. */
  start: number;
  end: number;
}

const text = (view: DataView, at: number): string =>
  String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );

/** The boxes directly inside `[from, to)` of `view`. */
function children(view: DataView, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = text(view, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    boxes.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

const child = (view: DataView, box: Box, type: string): Box | undefined =>
  children(view, box.start, box.end).find((candidate) => candidate.type === type);

/** The `moov` box's bytes (with its header), found by walking the top-level box headers. */
async function readMoov(blob: Blob): Promise<DataView | null> {
  let at = 0;
  while (at + 8 <= blob.size) {
    const head = new DataView(await blob.slice(at, at + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = text(head, 4);
    if (size === 1 && head.byteLength >= 16) size = Number(head.getBigUint64(8));
    else if (size === 0) size = blob.size - at;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > MAX_MOOV_BYTES) return null;
      return new DataView(await blob.slice(at, at + size).arrayBuffer());
    }
    at += size;
  }
  return null;
}

function trackRate(view: DataView, trak: Box): number | null {
  const mdia = child(view, trak, 'mdia');
  if (!mdia) return null;
  const hdlr = child(view, mdia, 'hdlr');
  if (!hdlr || hdlr.end - hdlr.start < 12 || text(view, hdlr.start + 8) !== 'vide') return null;
  const mdhd = child(view, mdia, 'mdhd');
  const stts = child(view, child(view, child(view, mdia, 'minf') ?? mdia, 'stbl') ?? mdia, 'stts');
  if (!mdhd || !stts) return null;
  const timescale =
    view.getUint8(mdhd.start) === 1
      ? view.getUint32(mdhd.start + 20)
      : view.getUint32(mdhd.start + 12);
  const entries = view.getUint32(stts.start + 4);
  let best = { count: 0, delta: 0 };
  for (let i = 0; i < entries; i++) {
    const at = stts.start + 8 + i * 8;
    if (at + 8 > stts.end) break;
    const count = view.getUint32(at);
    const delta = view.getUint32(at + 4);
    if (count > best.count && delta > 0) best = { count, delta };
  }
  if (!(timescale > 0) || best.delta === 0) return null;
  return timescale / best.delta;
}

/** Frames per second of a video file's first video track, or `DEFAULT_FPS`. */
export async function frameRateOf(blob: Blob): Promise<number> {
  try {
    const moov = await readMoov(blob);
    if (!moov) return DEFAULT_FPS;
    const top = children(moov, 0, moov.byteLength)[0];
    if (!top) return DEFAULT_FPS;
    for (const trak of children(moov, top.start, top.end).filter((box) => box.type === 'trak')) {
      const rate = trackRate(moov, trak);
      if (rate !== null && rate >= 1 && rate <= 240) return rate;
    }
  } catch {
    // Not an MP4/MOV, or damaged: the default.
  }
  return DEFAULT_FPS;
}
