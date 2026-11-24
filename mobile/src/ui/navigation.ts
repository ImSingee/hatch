import { glyphs } from './glyph.types';

export const tabDetails = {
  // The home tab keeps the `dashboard` id: saved tab orders and links name it.
  dashboard: {
    label: 'Home',
    glyph: 'home',
    icon: glyphs.home,
    androidIcon: 'home',
    detail: 'Widgets and pinned shortcuts',
  },
  apps: {
    label: 'Apps',
    glyph: 'apps',
    icon: glyphs.apps,
    androidIcon: 'apps',
    detail: 'Every App',
  },
  agent: {
    label: 'Agent',
    glyph: 'agent',
    icon: glyphs.agent,
    androidIcon: 'auto_awesome',
    detail: 'Conversations with your Agent',
  },
} as const;

/** The last tab: this phone, its instance and everything not in the bar. */
export const meTab = {
  label: 'Me',
  glyph: 'person',
  icon: glyphs.person,
  androidIcon: 'person',
} as const;
