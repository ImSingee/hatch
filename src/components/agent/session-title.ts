import type { useI18n } from '~i18n';

type Translate = ReturnType<typeof useI18n>['t'];

/** The title the server stores for a chat it has not named yet. */
const DEFAULT_SESSION_TITLE = 'New chat';

/**
 * A chat's title for display. Untitled chats are stored with the English
 * default, so that one is translated; every other title is user data.
 */
export function displaySessionTitle(title: string, t: Translate): string {
  return title === DEFAULT_SESSION_TITLE ? t('agent.chat.defaultTitle') : title;
}
