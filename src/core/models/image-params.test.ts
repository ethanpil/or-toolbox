import { describe, expect, it } from 'vitest';
import { aspectValue, bareImageControls, closestAspect, imageModelControls } from './image-params';

describe('imageModelControls', () => {
  it('reads enum, range and boolean descriptors; ignores malformed ones', () => {
    const controls = imageModelControls({
      id: 'x/model',
      name: 'Model',
      supported_parameters: {
        aspect_ratio: { type: 'enum', values: ['1:1', 7, '', '16:9'] },
        n: { type: 'range', min: 0, max: 4 },
        input_references: { type: 'range', min: 3, max: 1 },
        seed: { type: 'boolean' },
        size: { type: 'enum', values: ['1024x1024'] },
        quality: { type: 'enum', values: [] },
      },
      supports_streaming: true,
    });
    expect(controls).toMatchObject({
      aspectRatios: ['1:1', '16:9'],
      n: { min: 1, max: 4 },
      references: null,
      seed: true,
      sizes: ['1024x1024'],
      qualities: null,
      streaming: true,
    });
    expect(bareImageControls('y/model')).toMatchObject({
      name: 'y/model',
      references: null,
      seed: false,
    });
  });
});

describe('aspect ratios', () => {
  it('parses ratios and finds the closest offered one on a log scale', () => {
    expect(aspectValue('16:9')).toBeCloseTo(16 / 9);
    expect(aspectValue('2.35:1')).toBeCloseTo(2.35);
    expect(aspectValue('auto')).toBeNull();
    expect(closestAspect(1024, 1024, ['16:9', '1:1', 'auto'])).toBe('1:1');
    expect(closestAspect(1920, 1080, ['1:1', '4:3', '16:9'])).toBe('16:9');
    expect(closestAspect(1000, 2000, ['1:1', '9:16', '2:3'])).toBe('9:16');
    expect(closestAspect(100, 100, ['auto'])).toBeNull();
    expect(closestAspect(100, 100, null)).toBeNull();
  });
});
