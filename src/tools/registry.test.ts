import iconNames from 'bootstrap-icons/font/bootstrap-icons.json?raw';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { findTool, getTool, tools, toolsInCategory, validateManifest } from './registry';
import { TOOL_CATEGORIES, TOOL_IDS } from './types';

const VALID = getTool('ocr');

describe('tool registry', () => {
  it('has exactly one manifest per tool id, in canonical order', () => {
    expect(tools.map((tool) => tool.id)).toEqual([...TOOL_IDS]);
    expect(tools).toHaveLength(14);
  });

  it('looks tools up by id', () => {
    expect(getTool('ocr').name).toBe('OCR');
    expect(getTool('video-studio').usesJobs).toBe(true);
  });

  it('finds a tool by an id that may not exist', () => {
    expect(findTool('ocr')).toBe(getTool('ocr'));
    expect(findTool('gone')).toBeUndefined();
    expect(findTool('constructor')).toBeUndefined();
  });

  it('groups tools into the five categories', () => {
    const grouped = Object.fromEntries(
      TOOL_CATEGORIES.map((category) => [category, toolsInCategory(category).map((t) => t.id)]),
    );
    expect(grouped).toEqual({
      documents: ['chat', 'ocr', 'data-extractor', 'table-extractor'],
      audio: ['speech-to-text', 'text-to-speech', 'music-generation'],
      images: ['image-generation', 'image-editor', 'isolated-image'],
      video: ['video-studio'],
      reasoning: ['decision', 'bot-to-bot', 'model-arena'],
    });
  });

  it('only uses icons that exist in Bootstrap Icons', () => {
    const icons = JSON.parse(iconNames) as Record<string, number>;
    for (const tool of tools)
      expect(Object.hasOwn(icons, tool.icon), `${tool.id}: ${tool.icon}`).toBe(true);
  });

  it('marks the tools that choose their own models', () => {
    expect(tools.filter((tool) => tool.ownModels === true).map((tool) => tool.id)).toEqual([
      'bot-to-bot',
      'model-arena',
    ]);
  });

  it('only names lazy libraries that are installed', () => {
    const dependencies = Object.keys(pkg.dependencies);
    for (const tool of tools) {
      for (const lib of tool.lazyLibs) expect(dependencies, `${tool.id}: ${lib}`).toContain(lib);
    }
  });
});

describe('validateManifest', () => {
  const broken = (changes: Record<string, unknown>) => () =>
    validateManifest('ocr', { ...VALID, ...changes });

  it('accepts a valid manifest', () => {
    expect(validateManifest('ocr', { ...VALID })).toEqual(VALID);
  });

  it.each([
    [{ id: 'chat' }, /"id" is "chat" but the folder is "ocr"/],
    [{ id: 'nope' }, /"id" must be one of/],
    [{ name: '' }, /"name" must be a non-empty string/],
    [{ description: 42 }, /"description" must be a non-empty string/],
    [{ category: 'misc' }, /"category" must be one of documents/],
    [{ icon: 'bi-x' }, /"icon" must be a Bootstrap Icons name/],
    [{ capabilities: [] }, /"capabilities" must be a non-empty list/],
    [{ capabilities: ['vision', 'telepathy'] }, /"capabilities" must be/],
    [{ accepts: 'image/png' }, /"accepts" must be a list of MIME types/],
    [{ produces: [] }, /"produces" must be a non-empty list/],
    [{ usesJobs: 'no' }, /"usesJobs" must be true or false/],
    [{ lazyLibs: [1] }, /"lazyLibs" must be a list/],
    [{ defaults: [] }, /"defaults" must be an object/],
    [{ ownModels: 'yes' }, /"ownModels" must be true or false/],
    [{ entry: './main.ts' }, /unknown field "entry"/],
  ])('rejects %o', (changes, message) => {
    expect(broken(changes)).toThrow(message);
    expect(broken(changes)).toThrow(/^src\/tools\/ocr\/manifest\.json: /);
  });

  it('takes ownModels as an optional flag', () => {
    expect(validateManifest('ocr', { ...VALID, ownModels: true })).toMatchObject({
      ownModels: true,
    });
    expect(VALID.ownModels).toBeUndefined();
  });

  it('rejects missing fields and non-objects', () => {
    const withoutJobs: Record<string, unknown> = { ...VALID };
    delete withoutJobs.usesJobs;
    expect(() => validateManifest('ocr', withoutJobs)).toThrow(/"usesJobs" is missing/);
    expect(() => validateManifest('ocr', [])).toThrow(/must be a JSON object/);
  });
});
