/**
 * The list of tools, built from every `src/tools/<id>/manifest.json`.
 *
 * Manifests are small and bundled eagerly: Home, the navbar and the command
 * palette need them on every page. Tool code is not imported here; each tool
 * page loads its own `main.ts`.
 */
import {
  CAPABILITIES,
  TOOL_CATEGORIES,
  TOOL_IDS,
  type ToolCategory,
  type ToolId,
  type ToolManifest,
} from './types';

const manifests = import.meta.glob<ToolManifest>('./*/manifest.json', {
  eager: true,
  import: 'default',
});

/**
 * Checks what JSON cannot be type-checked for. A wrong manifest is a
 * programming error, so this throws at page start rather than degrading.
 */
function validate(folder: string, manifest: ToolManifest): ToolManifest {
  const fail = (problem: string): never => {
    throw new Error(`src/tools/${folder}/manifest.json: ${problem}`);
  };
  if (manifest.id !== folder) fail(`id "${manifest.id}" must match the folder name`);
  if (!(TOOL_IDS as readonly string[]).includes(manifest.id)) fail('id is not listed in TOOL_IDS');
  if (!(TOOL_CATEGORIES as readonly string[]).includes(manifest.category)) {
    fail(`unknown category "${manifest.category}"`);
  }
  if (manifest.capabilities.length === 0) fail('needs at least one capability');
  for (const capability of manifest.capabilities) {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) {
      fail(`unknown capability "${capability}"`);
    }
  }
  return manifest;
}

const byId = new Map<string, ToolManifest>(
  Object.entries(manifests).map(([path, manifest]) => {
    // path is './<folder>/manifest.json'
    const folder = path.split('/')[1] ?? '';
    return [folder, validate(folder, manifest)];
  }),
);

/** The manifest of one tool. */
export function getTool(id: ToolId): ToolManifest {
  const manifest = byId.get(id);
  if (!manifest) throw new Error(`No manifest found for tool "${id}"`);
  return manifest;
}

/** Every tool, in the canonical order of `TOOL_IDS`. */
export const tools: readonly ToolManifest[] = TOOL_IDS.map(getTool);

/** The tools of one category, in canonical order. */
export function toolsInCategory(category: ToolCategory): ToolManifest[] {
  return tools.filter((tool) => tool.category === category);
}
