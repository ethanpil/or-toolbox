import { describe, expect, it } from 'vitest';
import {
  buildEditRequest,
  DEFAULT_SETTINGS,
  editInstruction,
  type EditorSettings,
  parseSettings,
  referenceRoles,
  settingsRecord,
} from './request';

describe('references and instructions', () => {
  it('sends the marked picture, the plain one and the mask, as many as the model takes', () => {
    expect(referenceRoles('inpaint', 16)).toEqual(['marked', 'plain', 'mask']);
    expect(referenceRoles('outpaint', 2)).toEqual(['marked', 'plain']);
    expect(referenceRoles('inpaint', 1)).toEqual(['marked']);
    expect(referenceRoles('whole', 8)).toEqual(['plain']);
    expect(referenceRoles('inpaint', 0)).toEqual([]);
  });

  it('names each reference and the marked area in the inpaint instruction', () => {
    const text = editInstruction('inpaint', ' a red boat ', ['marked', 'plain', 'mask']);
    expect(text).toContain(
      'The first reference image shows the picture with the area to change tinted magenta; the second reference image is the same picture without any marks; the third reference image is a black-and-white mask where white is the area to change.',
    );
    expect(text).toContain('Change only the marked area: a red boat.');
    expect(text).toContain('Keep everything outside the marked area exactly as it is');
    expect(text).toContain('without any magenta tint');
    expect(editInstruction('inpaint', 'x', ['marked'])).not.toContain('second reference');
  });

  it('describes the empty area for outpaint, and needs no instruction', () => {
    const text = editInstruction('outpaint', '', ['marked', 'plain']);
    expect(text).toContain('the empty area to fill tinted magenta');
    expect(text).toContain('extending the scene naturally beyond its edges.');
    expect(editInstruction('outpaint', 'more beach', ['marked'])).toContain(
      'beyond its edges: more beach',
    );
    expect(editInstruction('whole', 'winter', ['plain'])).toBe(
      'Edit the reference image: winter. Return the whole edited picture, same framing.',
    );
  });

  it('builds the body: references in order, the closest aspect ratio, PNG when offered', () => {
    const body = buildEditRequest({
      model: 'test/editor',
      mode: 'inpaint',
      instruction: 'a red boat',
      roles: ['marked', 'plain', 'mask'],
      references: [
        'data:image/png;base64,MARKED',
        'data:image/jpeg;base64,PLAIN',
        'data:image/png;base64,MASK',
      ],
      controls: { aspectRatios: ['1:1', '4:3', '16:9', 'auto'], outputFormats: ['jpeg', 'png'] },
      width: 1500,
      height: 1000,
    });
    expect(body).toMatchObject({
      model: 'test/editor',
      aspect_ratio: '4:3',
      output_format: 'png',
      input_references: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,MARKED' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,PLAIN' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,MASK' } },
      ],
    });
    expect(body.prompt).toContain('a red boat');
    const bare = buildEditRequest({
      model: 'test/editor',
      mode: 'whole',
      instruction: 'x',
      roles: ['plain'],
      references: ['data:,'],
      controls: { aspectRatios: null, outputFormats: ['jpeg'] },
      width: 10,
      height: 10,
    });
    expect(bare.aspect_ratio).toBeUndefined();
    expect(bare.output_format).toBeUndefined();
  });
});

describe('editor settings', () => {
  it('round-trips and repairs what storage returns', () => {
    const settings: EditorSettings = {
      mode: 'outpaint',
      keepOutside: false,
      feather: 12,
      extend: '16:9',
      margins: { top: 10, right: 20, bottom: 30, left: 40 },
    };
    expect(parseSettings(settingsRecord(settings))).toEqual(settings);
    expect(
      parseSettings({ mode: 'paint', feather: 99, extend: 'wide', margins: { top: -1 } }),
    ).toEqual(DEFAULT_SETTINGS);
  });
});
