/**
 * How each capability is called and drawn, in one place:
 *
 * - `label`: the lower-case word for sentences ("No free video model exists", "Choose a text-to-speech model"),
 * - `title`: the display name (Settings rows, announcements),
 * - `badge`: the short tag on a model card,
 * - `filter`: the text of the Models page's capability filter,
 * - `icon`: a Bootstrap Icons name without `bi-`,
 * - `help`: a note the model picker shows under its search box, where the catalog alone does not say enough.
 */
import type { Capability } from '../types';

export interface CapabilityInfo {
  label: string;
  title: string;
  badge: string;
  filter: string;
  icon: string;
  help?: string;
}

export const CAPABILITY_INFO: Readonly<Record<Capability, CapabilityInfo>> = {
  text: {
    label: 'text',
    title: 'Text',
    badge: 'Text',
    filter: 'Text',
    icon: 'chat-left-text',
  },
  vision: {
    label: 'vision',
    title: 'Vision',
    badge: 'Vision',
    filter: 'Vision (image input)',
    icon: 'eye',
  },
  image: {
    label: 'image',
    title: 'Image generation',
    badge: 'Image',
    filter: 'Image generation',
    icon: 'image',
  },
  tts: {
    label: 'text-to-speech',
    title: 'Text-to-speech',
    badge: 'Speech',
    filter: 'Text to speech',
    icon: 'megaphone',
  },
  stt: {
    label: 'speech-to-text',
    title: 'Speech-to-text',
    badge: 'Transcribe',
    filter: 'Speech to text',
    icon: 'mic',
  },
  video: {
    label: 'video',
    title: 'Video',
    badge: 'Video',
    filter: 'Video generation',
    icon: 'camera-reels',
  },
  music: {
    label: 'music',
    title: 'Music',
    badge: 'Music',
    filter: 'Music',
    icon: 'music-note-beamed',
  },
  decisions: {
    label: 'decision',
    title: 'Decisions',
    badge: 'Decisions',
    filter: 'Decisions',
    icon: 'signpost-split',
    help: 'Jev and Mercury Decide are the only models verified to accept the Decision tool’s questions. Others in this list may refuse them or answer in another shape.',
  },
};
