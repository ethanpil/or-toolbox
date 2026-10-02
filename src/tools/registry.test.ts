import { describe, expect, it } from 'vitest';
import { getTool, tools, toolsInCategory } from './registry';
import { TOOL_CATEGORIES, TOOL_IDS } from './types';

describe('tool registry', () => {
  it('has exactly one manifest per tool id, in canonical order', () => {
    expect(tools.map((tool) => tool.id)).toEqual([...TOOL_IDS]);
    expect(tools).toHaveLength(14);
  });

  it('looks tools up by id', () => {
    expect(getTool('ocr').name).toBe('OCR');
    expect(getTool('video-studio').usesJobs).toBe(true);
  });

  it('gives every tool the fields the shell needs', () => {
    for (const tool of tools) {
      expect(tool.name, tool.id).not.toBe('');
      expect(tool.description, tool.id).not.toBe('');
      expect(tool.icon, tool.id).toMatch(/^[a-z0-9-]+$/);
      expect(tool.capabilities.length, tool.id).toBeGreaterThan(0);
      expect(Array.isArray(tool.accepts), tool.id).toBe(true);
      expect(tool.produces.length, tool.id).toBeGreaterThan(0);
      expect(typeof tool.usesJobs, tool.id).toBe('boolean');
      expect(Array.isArray(tool.lazyLibs), tool.id).toBe(true);
      expect(typeof tool.defaults, tool.id).toBe('object');
    }
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

  it('only names lazy libraries that are installed', async () => {
    const pkg = (await import('../../package.json')).default as {
      dependencies: Record<string, string>;
    };
    for (const tool of tools) {
      for (const lib of tool.lazyLibs) {
        expect(Object.keys(pkg.dependencies), `${tool.id}: ${lib}`).toContain(lib);
      }
    }
  });
});
