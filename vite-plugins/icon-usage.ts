import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Which Bootstrap Icons the code uses, for scripts/generate-icon-subset.mjs (which cuts the icon font and
 * stylesheet down to them) and the test that keeps the committed subset in step with the code.
 *
 * An icon is "used" when its name, with or without `bi-`, is a whole string in the code: `icon('gear')`,
 * `icon: 'lock'`, `class: 'bi bi-star-fill'`, `cond ? 'play-fill' : 'pause-fill'`, a manifest's `"icon"`. The scan
 * reads every string literal in src/ (not tests), so a name must be spelled out somewhere: a name built at run time
 * (`icon(base + '-fill')`) is not seen, and `declaredIcons()` cannot vouch for it either.
 */

/** Bootstrap Icons' name → code point table, from the installed package. */
export function iconCodepoints(root: string): Map<string, number> {
  const file = join(root, 'node_modules', 'bootstrap-icons', 'font', 'bootstrap-icons.json');
  const table = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
  return new Map(Object.entries(table));
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (/\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name)) found.push(path);
    else if (entry.name === 'manifest.json') found.push(path);
  }
  return found;
}

/** Every string in a file: string literals and the text parts of template literals; a manifest's string values. */
function stringsIn(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  if (file.endsWith('.json')) {
    JSON.stringify(JSON.parse(text), (_key, value: unknown) => {
      if (typeof value === 'string') found.push(value);
      return value;
    });
    return found;
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** The icons the code uses (names without `bi-`), sorted. */
export function usedIcons(root: string, known: ReadonlyMap<string, number>): string[] {
  const used = new Set<string>();
  for (const file of sourceFiles(join(root, 'src'))) {
    for (const string of stringsIn(file)) {
      // A bare name must be the whole string (`'gear'`); inside a class list only `bi-` names count, so words in
      // sentences ("Add an alt text") do not pull icons in.
      if (known.has(string)) used.add(string);
      for (const word of string.split(/\s+/)) {
        if (word.startsWith('bi-') && known.has(word.slice(3))) used.add(word.slice(3));
      }
    }
  }
  return [...used].sort();
}

export interface DeclaredIcon {
  name: string;
  file: string;
}

/**
 * The icon names the code asks for outright: the first argument of `icon(...)`, `icon: '...'` options and a
 * manifest's `icon`. A name that is not in the font renders as an empty box, so the test checks these.
 */
export function declaredIcons(root: string): DeclaredIcon[] {
  const declared: DeclaredIcon[] = [];
  for (const file of sourceFiles(join(root, 'src'))) {
    if (file.endsWith('.json')) {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { icon?: unknown };
      if (typeof manifest.icon === 'string') declared.push({ name: manifest.icon, file });
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'icon'
      ) {
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) declared.push({ name: first.text, file });
      } else if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === 'icon' &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        declared.push({ name: node.initializer.text, file });
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  }
  return declared;
}
