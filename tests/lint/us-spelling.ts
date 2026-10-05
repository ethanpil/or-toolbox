/**
 * The US-spelling check behind tests/lint/us-spelling.test.ts.
 *
 * ORtoolbox's UI text uses US spelling ("color", "canceled", "organize"). New
 * text keeps arriving from authors who default to British English, so this
 * finds British spellings in the places a person can read or hear:
 *
 * - string and template-literal text in src/**\/*.ts (comments, identifiers,
 *   regular expressions, import paths and string-literal types are not read),
 * - the <title> of every HTML entry,
 * - the string values of src/tools/<id>/manifest.json and
 *   public/manifest.webmanifest.
 *
 * Unit tests (*.test.ts) are not scanned: their titles are developer text and
 * what they type into the app is test data. A test that asserts UI text fails
 * on its own when the text and the assertion disagree.
 *
 * A hit is a word matched by the denylist below. When the literal is not UI
 * text (a storage field, a state or error code, an instruction sent to a
 * model) it goes on ALLOWED with the reason, so the exception shows in review.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { discoverPages } from '../../vite-plugins/pages.ts';

export const ROOT = join(import.meta.dirname, '..', '..');

/** Fixed British spellings, each a regular-expression fragment matched as a whole word. */
const BRITISH_WORDS = [
  // -our (not "your", "hour", "four", "tour", "glamour", ...)
  '\\w*(?:colo|favo|hono|flavo|neighbo|behavio|labo|humo|rumo|harbo|vapo|savo|savio|endeavo|armo|odo|tumo|rigo|vigo|valo|splendo|clamo|fervo|parlo|arbo|cando|ardo|demeano)ur\\w*',
  // -re
  '\\w*(?:centre|metre|litre|fibre|theatre|calibre|lustre|sombre|spectre|meagre|manoeuvre|sabre)\\w*',
  'centring',
  // A doubled l before -ed/-ing/-er (cancelled, labelled, modelled, travelled, ...)
  '(?:cancel|label|model|travel|signal|total|fuel|level|channel|counsel|marshal|marvel|quarrel|rival|tunnel|equal|pencil|dial|duel|libel|panel|shovel|swivel|jewel|grovel|funnel|gravel|parcel)l(?:ed|ing|er|ers|or|ors|ist|ists|ous|ery)',
  'skilful(?:ly)?',
  'wilful(?:ly)?',
  'fulfil|fulfils|fulfilment',
  'enrol|enrols|enrolment|enrolments',
  'instalment|instalments',
  'woollen|woolly',
  'focuss(?:ed|es|ing)|targett(?:ed|ing)|benefitt(?:ed|ing)|biass(?:ed|ing)',
  // -ogue, -ence, -ement, -ae-, -ou-, and other single words
  'catalogues?|dialogues?|analogues?|monologues?|epilogues?|prologues?',
  'licences?|licenced',
  'defences?|defenceless|offences?|pretences?',
  'judgements?|acknowledgements?|abridgements?',
  'ageing|artefacts?|programmes?|speciality|specialities',
  'whilst|amongst|amidst',
  'learnt|spelt|burnt|dreamt|leapt|spoilt',
  'greys?|greyed|greying|greyish|greyer|greyest|greyscale',
  'tyres?|kerbs?|ploughs?|draughts?|cheques?|moulds?|moulded|moulding|moult|smoulder\\w*',
  'sceptic\\w*|sulphur\\w*|aluminium|pyjamas|storeys',
  'anaemi\\w*|oestrogen|foetus|paediatric\\w*|encyclopaedia\\w*|aeroplanes?',
  'enquir(?:y|ies|e|es|ed|ing)',
  'orientated|cosy|maths|gaol|anticlockwise',
];

const BRITISH = new RegExp(`\\b(?:${BRITISH_WORDS.join('|')})\\b`, 'gi');

/**
 * -ise, -isation and -yse words (summarise, organisation, analyse, ...). Every
 * one is British unless it is on REAL_ISE_WORDS, the closed list of English
 * words that end in -ise in the US as well.
 */
const IZE_FAMILY = /\b[a-z]{3,}(?:is|ys)(?:e|es|ed|ing|ation|ations|er|ers|able)\b/gi;

/**
 * Words IZE_FAMILY also matches that are spelled the same in US English
 * (-vise, -prise, -mise, -cise, -wise, -guise, ...; "analyses" is the plural
 * of "analysis"; "Denise" is a name). Add a word here only when it is one.
 */
const REAL_ISE_WORDS = new Set(
  (
    'advertise advertised advertises advertising advertiser advertisers ' +
    'advise advised advises advising adviser advisers advisable ' +
    'appraise appraised appraises appraising appraiser appraisers apprise apprised apprises apprising ' +
    'braise braised bruise bruised bruises bruiser chaise cruise cruised cruises cruiser cruisers cruising ' +
    'chastise chastised chastises chastising circumcise comprise comprised comprises comprising ' +
    'compromise compromised compromises compromising concise demise demised demises ' +
    'despise despised despises despising devise devised devises devising devisable disguise disguised disguises disguising ' +
    'enterprise enterprises excise excised excises exercise exercised exercises exercising exerciser ' +
    'expertise franchise franchised franchises fundraiser fundraisers ' +
    'improvise improvised improvises improvising improviser improvisers incise incised ' +
    'merchandise merchandised merchandising paradise paradises praise praised praises praising ' +
    'precise premise premised premises prise prised promise promised promises promising promiser promisers ' +
    'reprise reprised revise revised revises revising revisable supervise supervised supervises supervising ' +
    'sunrise sunrises moonrise surmise surmised surmises surprise surprised surprises surprising surprisingly ' +
    'televise televised televises tortoise tortoises treatise treatises turquoise valise valises ' +
    'analyses denise ' +
    // -wise adverbs
    'otherwise likewise clockwise counterclockwise lengthwise crosswise stepwise pairwise bitwise ' +
    'elementwise columnwise rowwise piecewise edgewise sidewise slantwise'
  ).split(/\s+/),
);

/** British spellings in one piece of text, lower-cased, each once. */
export function findBritish(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(BRITISH)) found.add(match[0].toLowerCase());
  for (const match of text.matchAll(IZE_FAMILY)) {
    const word = match[0].toLowerCase();
    if (!REAL_ISE_WORDS.has(word)) found.add(word);
  }
  return [...found];
}

export interface Finding {
  /** Relative to the repository root, forward slashes. */
  file: string;
  line: number;
  /** The British word, lower-cased. */
  word: string;
  /** The whole literal it was found in. */
  text: string;
}

/**
 * A literal that is deliberately not US spelling because it is not text a
 * person reads. `file` and `word` must match the finding; with `text` only a
 * literal that is exactly that text is allowed (use it for short codes and keys
 * in files that also hold UI text), without it any literal in the file with
 * that word is (for instruction texts sent to a model). The reason is mandatory.
 */
export interface Allowed {
  file: string;
  word: string;
  text?: string;
  reason: string;
}

export const ALLOWED: readonly Allowed[] = [
  // Job states and error codes: stored values and OpenRouter's own status names.
  {
    file: 'src/core/api/client.ts',
    word: 'cancelled',
    text: 'cancelled',
    reason: "OpenRouter's video job status value",
  },
  {
    file: 'src/core/backup/index.ts',
    word: 'cancelled',
    text: 'cancelled',
    reason: 'job state, validated on import of stored jobs',
  },
  {
    file: 'src/core/errors.ts',
    word: 'cancelled',
    text: 'cancelled',
    reason: 'the OrError code of RunCancelledError (switched on by presentError and the tools)',
  },
  {
    file: 'src/core/jobs/index.ts',
    word: 'cancelled',
    text: 'cancelled',
    reason: 'job state, stored in IndexedDB',
  },
  {
    file: 'src/tools/video-studio/sequence-runner.ts',
    word: 'cancelled',
    text: 'cancelled',
    reason: 'compared with the OrError code',
  },
  {
    file: 'src/tools/video-studio/tool.ts',
    word: 'cancelled',
    text: 'cancelled',
    reason: 'job state',
  },
  {
    file: 'src/ui/components/job-list.ts',
    word: 'cancelled',
    text: 'cancelled',
    reason: 'job state (its label, "Canceled", is US)',
  },
  {
    file: 'src/ui/feedback/errors.ts',
    word: 'cancelled',
    text: 'cancelled',
    reason: 'compared with the OrError code',
  },
  // Stored settings written before the US spelling: still read, never shown.
  {
    file: 'src/core/settings/schema.ts',
    word: 'favouritetools',
    reason: 'settings field of older versions, read so saved favorites are kept',
  },
  {
    file: 'src/core/settings/schema.ts',
    word: 'favourites',
    reason: 'settings field of older versions, read so saved favorites are kept',
  },
  // Identifiers that tests and storage depend on.
  {
    file: 'src/pages/settings/keys.ts',
    word: 'colour',
    text: 'key-colour',
    reason: 'data-testid',
  },
  {
    file: 'src/pages/settings/keys.ts',
    word: 'colour',
    text: ':colour',
    reason: 'end of a data-focus-key',
  },
  // Hidden search words: a person who types the British spelling still finds it.
  {
    file: 'src/ui/shell/palette.ts',
    word: 'colour',
    text: 'appearance color colour mode',
    reason: 'command palette search keywords, not displayed',
  },
  // Instructions sent to models are not UI.
  {
    file: 'src/tools/image-editor/request.ts',
    word: 'grey',
    text: 'grey',
    reason: 'instruction sent to the model (the canvas is filled grey)',
  },
  {
    file: 'src/tools/isolated-image/request.ts',
    word: 'colours',
    reason: 'instruction sent to the model',
  },
  {
    file: 'src/tools/ocr/ocr.ts',
    word: 'summarise',
    reason: 'instruction sent to the model',
  },
];

export function isAllowed(finding: Finding): boolean {
  return ALLOWED.some(
    (entry) =>
      entry.file === finding.file &&
      entry.word === finding.word &&
      (entry.text === undefined || entry.text === finding.text),
  );
}

/**
 * The text of every string and template literal in `code`, with its line.
 * Module paths and string-literal types are code, not text, and are skipped.
 */
export function literalTexts(fileName: string, code: string): { text: string; line: number }[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest);
  const out: { text: string; line: number }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isLiteralTypeNode(node) || ts.isImportTypeNode(node)) return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      out.push({ text: node.text, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const rel = (path: string): string => relative(ROOT, path).replaceAll('\\', '/');

/** Every *.ts file under `dir` that is not a unit test or a declaration file. */
export function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

let typeScriptFindings: Finding[] | undefined;

/**
 * Every British spelling in the string literals of src/. A file whose raw text
 * has none (comments included) cannot have one in a literal, so only the other
 * files are parsed; that keeps the check fast. Computed once.
 */
export function scanTypeScript(): Finding[] {
  if (typeScriptFindings) return typeScriptFindings;
  const findings: Finding[] = [];
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const code = readFileSync(path, 'utf8');
    if (findBritish(code).length === 0) continue;
    const file = rel(path);
    for (const { text, line } of literalTexts(file, code)) {
      for (const word of findBritish(text)) findings.push({ file, line, word, text });
    }
  }
  typeScriptFindings = findings;
  return findings;
}

/** The HTML entries, found the way the build finds them. */
export const htmlEntries = (): string[] => discoverPages(ROOT).map((page) => page.file);

export function scanHtmlTitles(): Finding[] {
  const findings: Finding[] = [];
  for (const file of htmlEntries()) {
    const html = readFileSync(join(ROOT, file), 'utf8');
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    for (const word of findBritish(title)) findings.push({ file, line: 1, word, text: title });
  }
  return findings;
}

/** Every string value in a JSON document (keys are field names, not text). */
function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) jsonStrings(item, out);
  }
  return out;
}

/** The manifests whose names and descriptions people read: the web app's and each tool's. */
export function manifestFiles(): string[] {
  const files = [join(ROOT, 'public', 'manifest.webmanifest')];
  const tools = join(ROOT, 'src', 'tools');
  for (const entry of readdirSync(tools, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(join(tools, entry.name, 'manifest.json'));
  }
  return files;
}

export function scanManifests(): Finding[] {
  const findings: Finding[] = [];
  for (const path of manifestFiles()) {
    for (const text of jsonStrings(JSON.parse(readFileSync(path, 'utf8')))) {
      for (const word of findBritish(text)) {
        findings.push({ file: rel(path), line: 1, word, text });
      }
    }
  }
  return findings;
}

export const describeFinding = (f: Finding): string =>
  `${f.file}:${f.line}  "${f.word}"  in  ${JSON.stringify(f.text.slice(0, 100))}`;
