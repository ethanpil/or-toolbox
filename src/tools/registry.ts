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

const manifests = import.meta.glob<unknown>('./*/manifest.json', {
  eager: true,
  import: 'default',
});

/** A manifest key and the check its value must pass, with what to say when it does not. */
type FieldCheck = [key: keyof ToolManifest, valid: (value: unknown) => boolean, expected: string];

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const oneOf =
  (allowed: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === 'string' && allowed.includes(value);

const FIELDS: FieldCheck[] = [
  ['id', oneOf(TOOL_IDS), `one of ${TOOL_IDS.join(', ')}`],
  ['name', isString, 'a non-empty string'],
  ['description', isString, 'a non-empty string'],
  ['category', oneOf(TOOL_CATEGORIES), `one of ${TOOL_CATEGORIES.join(', ')}`],
  [
    'icon',
    (v) => isString(v) && /^(?!bi-)[a-z0-9-]+$/.test(v),
    'a Bootstrap Icons name without "bi-"',
  ],
  [
    'capabilities',
    (v) => isStringList(v) && v.length > 0 && v.every(oneOf(CAPABILITIES)),
    `a non-empty list of ${CAPABILITIES.join(', ')}`,
  ],
  ['accepts', isStringList, 'a list of MIME types'],
  ['produces', (v) => isStringList(v) && v.length > 0, 'a non-empty list of MIME types'],
  ['usesJobs', (v) => typeof v === 'boolean', 'true or false'],
  ['lazyLibs', isStringList, 'a list of npm package names'],
  [
    'defaults',
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    'an object of default settings',
  ],
];

/**
 * Checks a manifest against `ToolManifest`. A wrong manifest is a programming
 * error, so this throws at page start (and in the unit tests) rather than
 * degrading.
 */
export function validateManifest(folder: string, manifest: unknown): ToolManifest {
  const fail = (problem: string): never => {
    throw new Error(`src/tools/${folder}/manifest.json: ${problem}`);
  };
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    fail('must be a JSON object');
  }
  const record = manifest as Record<string, unknown>;

  for (const [key, valid, expected] of FIELDS) {
    if (!(key in record)) fail(`"${key}" is missing`);
    if (!valid(record[key]))
      fail(`"${key}" must be ${expected}, got ${JSON.stringify(record[key])}`);
  }
  const known = new Set<string>(FIELDS.map(([key]) => key));
  for (const key of Object.keys(record)) {
    if (!known.has(key)) fail(`unknown field "${key}"`);
  }
  if (record.id !== folder) fail(`"id" is "${String(record.id)}" but the folder is "${folder}"`);

  return record as unknown as ToolManifest;
}

const byId = new Map<string, ToolManifest>(
  Object.entries(manifests).map(([path, manifest]) => {
    // path is './<folder>/manifest.json'
    const folder = path.split('/')[1] ?? '';
    return [folder, validateManifest(folder, manifest)];
  }),
);

/** The manifest of one tool. */
export function getTool(id: ToolId): ToolManifest {
  const manifest = byId.get(id);
  if (!manifest)
    throw new Error(`No manifest found for tool "${id}" (src/tools/${id}/manifest.json)`);
  return manifest;
}

/** Every tool, in the canonical order of `TOOL_IDS`. */
export const tools: readonly ToolManifest[] = TOOL_IDS.map(getTool);

/** The tools of one category, in canonical order. */
export function toolsInCategory(category: ToolCategory): ToolManifest[] {
  return tools.filter((tool) => tool.category === category);
}
