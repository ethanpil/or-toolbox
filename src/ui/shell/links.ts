/**
 * Every internal link the shell, palette and tools build, in one place. The Settings page must give each
 * section in `SETTINGS_SECTIONS` an element with that id (a tab or a section) and open it when the URL hash
 * names it, because the palette, error messages and onboarding deep-link to them.
 */
import { url } from '../../core/paths';
import type { ToolCategory, ToolId } from '../../tools/types';

/** Display names and icons of the tool categories (Home sections, the Tools menu, the palette). */
export const CATEGORY_INFO: Readonly<Record<ToolCategory, { label: string; icon: string }>> = {
  documents: { label: 'Documents', icon: 'file-earmark-text' },
  audio: { label: 'Audio', icon: 'soundwave' },
  images: { label: 'Images', icon: 'images' },
  video: { label: 'Video', icon: 'camera-reels' },
  reasoning: { label: 'Reasoning', icon: 'lightbulb' },
};

export const REPO_URL = 'https://github.com/ethanpil/or-toolbox';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/settings/keys';
export const OPENROUTER_PRIVACY_URL = 'https://openrouter.ai/privacy';
export const OPENROUTER_ZDR_URL = 'https://openrouter.ai/docs/guides/features/zdr';

export type SettingsSection =
  'keys' | 'models' | 'tools' | 'budgets' | 'appearance' | 'security' | 'data' | 'backup';

export interface SettingsSectionInfo {
  id: SettingsSection;
  label: string;
  icon: string;
  /** Extra words the command palette matches. */
  keywords: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionInfo[] = [
  { id: 'keys', label: 'Keys', icon: 'key', keywords: 'api key openrouter connect balance' },
  {
    id: 'models',
    label: 'Default models',
    icon: 'cpu',
    keywords: 'capability defaults free-only free only',
  },
  { id: 'tools', label: 'Tool bindings', icon: 'tools', keywords: 'per-tool key model pin' },
  {
    id: 'budgets',
    label: 'Budgets',
    icon: 'piggy-bank',
    keywords: 'spend limit monthly warn hard stop cost',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'palette',
    keywords: 'theme dark light accent density motion',
  },
  {
    id: 'security',
    label: 'Passphrase lock',
    icon: 'shield-lock',
    keywords: 'lock encrypt passphrase auto-lock',
  },
  {
    id: 'data',
    label: 'Data',
    icon: 'database',
    keywords: 'history retention delete prompts storage reset',
  },
  {
    id: 'backup',
    label: 'Backup and restore',
    icon: 'cloud-arrow-down',
    keywords: 'export import file',
  },
];

export function settingsUrl(section?: SettingsSection): string {
  return url(section ? `settings/#${section}` : 'settings/');
}

/** A tool page, with optional query parameters (`run`, `prompt`, `model`, `sample`, `receive`). */
export function toolUrl(id: ToolId, params?: Record<string, string>): string {
  const query = params ? new URLSearchParams(params).toString() : '';
  return url(`tools/${id}/${query ? `?${query}` : ''}`);
}

/** History, optionally filtered to one tool (`?tool=`) or opened on one run (`?run=`). */
export function historyUrl(params: { tool?: ToolId; run?: string } = {}): string {
  const query = new URLSearchParams();
  if (params.tool) query.set('tool', params.tool);
  if (params.run) query.set('run', params.run);
  const text = query.toString();
  return url(`history/${text ? `?${text}` : ''}`);
}

export function modelsUrl(query?: string): string {
  return url(query ? `models/?${new URLSearchParams({ q: query }).toString()}` : 'models/');
}

/** Platform pages, for the navbar and the palette. `nav` is what `mountPage({ nav })` marks as current. */
export type NavKey =
  'home' | 'tools' | 'models' | 'history' | 'stats' | 'settings' | 'privacy' | 'diagnostics';

export const PAGES: readonly {
  key: NavKey;
  label: string;
  icon: string;
  path: string;
  keywords: string;
}[] = [
  { key: 'home', label: 'Home', icon: 'house', path: '', keywords: 'start tools favourites' },
  {
    key: 'models',
    label: 'Models',
    icon: 'cpu',
    path: 'models/',
    keywords: 'catalog compare price',
  },
  {
    key: 'history',
    label: 'History',
    icon: 'clock-history',
    path: 'history/',
    keywords: 'runs timeline past',
  },
  {
    key: 'stats',
    label: 'Stats',
    icon: 'bar-chart',
    path: 'stats/',
    keywords: 'spend usage dashboard cost',
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'gear',
    path: 'settings/',
    keywords: 'preferences options',
  },
  {
    key: 'privacy',
    label: 'Privacy',
    icon: 'shield-check',
    path: 'privacy/',
    keywords: 'data storage policy',
  },
  {
    key: 'diagnostics',
    label: 'Diagnostics',
    icon: 'activity',
    path: 'diagnostics/',
    keywords: 'isolation ffmpeg service worker browser',
  },
];
