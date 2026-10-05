/**
 * The tool contract's static half: what the shell knows about a tool before
 * any of the tool's code loads. One `manifest.json` per tool folder, collected
 * by `registry.ts`.
 */

/** Tool ids. Also the folder name under src/tools/ and the URL segment under tools/. */
export const TOOL_IDS = [
  'chat',
  'ocr',
  'data-extractor',
  'table-extractor',
  'speech-to-text',
  'text-to-speech',
  'music-generation',
  'image-generation',
  'image-editor',
  'isolated-image',
  'video-studio',
  'decision',
  'bot-to-bot',
  'model-arena',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Home page groups, in display order. */
export const TOOL_CATEGORIES = ['documents', 'audio', 'images', 'video', 'reasoning'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** What a tool asks of a model. Each capability has its own default model in Settings. */
export const CAPABILITIES = [
  'text',
  'vision',
  'image',
  'tts',
  'stt',
  'video',
  'music',
  'decisions',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface ToolManifest {
  id: ToolId;
  /** Display name. */
  name: string;
  /** One line for tool cards and the command palette. */
  description: string;
  category: ToolCategory;
  /** Bootstrap Icons name without the `bi-` prefix, e.g. `chat-dots`. */
  icon: string;
  /** Capabilities the tool uses; the first is its primary one. */
  capabilities: Capability[];
  /** MIME types the tool takes as input (`image/*` style wildcards allowed). */
  accepts: string[];
  /** MIME types the tool can export. */
  produces: string[];
  /** True if the tool runs long work through the persistent job queue. */
  usesJobs: boolean;
  /** npm packages the tool loads on demand with `import()`; never in the eager path. */
  lazyLibs: string[];
  /** Tool-level defaults: the bottom of the cascade run → tool → capability → global. */
  defaults: Record<string, unknown>;
  /**
   * True for a tool that chooses its models inside the tool (Model arena's contenders, Bot-to-bot's two bots) and
   * so shows no single model: its header has no model chip and no free-only substitution note (Run is still
   * disabled when free-only leaves it no model at all), and Settings → Tools offers no model picker for it. The
   * primary capability's model (the tool binding, else the capability default) is then only where a new setup
   * starts; `?model=` still arrives as `ctx.modelOverride` and the tool decides what it means. Default false.
   */
  ownModels?: boolean;
}
