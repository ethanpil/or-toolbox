import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../tools/types';
import { CAPABILITY_INFO } from './capabilities';

describe('capability info', () => {
  it('describes every capability', () => {
    for (const capability of CAPABILITIES) {
      const info = CAPABILITY_INFO[capability];
      expect(info.label, capability).not.toBe('');
      expect(info.icon, capability).not.toBe('');
    }
  });

  it('adds a note for the model picker only where the catalog alone does not say enough', () => {
    // Decisions: only Jev and Mercury Decide are verified to accept the Decision tool's questions.
    expect(CAPABILITY_INFO.decisions.help).toContain('Jev and Mercury Decide');
    expect(CAPABILITY_INFO.decisions.help).toContain('only models verified');
    expect(CAPABILITIES.filter((c) => CAPABILITY_INFO[c].help !== undefined)).toEqual([
      'decisions',
    ]);
  });
});
