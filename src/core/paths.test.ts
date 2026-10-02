import { afterEach, describe, expect, it, vi } from 'vitest';
import { url } from './paths';

describe('url', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the base for the site root', () => {
    expect(url()).toBe('/or-toolbox/');
    expect(url('')).toBe('/or-toolbox/');
    expect(url('/')).toBe('/or-toolbox/');
  });

  it('prefixes relative paths with the base', () => {
    expect(url('settings/')).toBe('/or-toolbox/settings/');
    expect(url('tools/chat/')).toBe('/or-toolbox/tools/chat/');
    expect(url('icons/logo.svg')).toBe('/or-toolbox/icons/logo.svg');
  });

  it('treats a leading slash as "from the site root", not the host root', () => {
    expect(url('/settings/')).toBe('/or-toolbox/settings/');
    expect(url('//settings/')).toBe('/or-toolbox/settings/');
  });

  it('keeps query strings and fragments', () => {
    expect(url('history/?tool=ocr#run-3')).toBe('/or-toolbox/history/?tool=ocr#run-3');
  });

  it('follows the configured base', () => {
    vi.stubEnv('BASE_URL', '/');
    expect(url('settings/')).toBe('/settings/');
  });
});
