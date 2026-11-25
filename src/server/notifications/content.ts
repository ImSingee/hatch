/**
 * How an edit changes a notification's content: which format it ends up in,
 * what its summary becomes, and whether its question changes with it.
 */
import {
  contentToLegacy,
  legacyToContent,
} from '../../../packages/hatch-platform-api/notification-content-legacy';
import {
  hasInlineInputs,
  summaryFromTitle,
} from '../../../packages/hatch-platform-api/notification-content';
import type { ReplyForm } from '../../../packages/hatch-platform-api/notification-reply';
import type { NotificationContentFields, NotificationUpdate } from './contract';

/** An edit the current content cannot take; the message names the field. */
export class ContentUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentUpdateError';
  }
}

export type ContentUpdate = {
  next: NotificationContentFields;
  /** The question after the edit; undefined keeps the current one. */
  reply: ReplyForm | null | undefined;
};

/**
 * The content after an edit.
 *
 * - `markdown` or a card in markup or as a tree switches to that format; the
 *   summary is the one given, else the current one.
 * - `title`, `body` and a #319 card (`legacyCard`, null to remove it) merge
 *   into a text notification or a card that is exactly the #319 shape, and
 *   the result is a card when a #319 card remains, text otherwise. A summary
 *   that was derived from the old title follows the new title (and goes
 *   away when a card becomes text); one the sender wrote is kept.
 * - On any other markdown or card notification they switch it to text, which
 *   needs `title`; its summary is kept unless one is given.
 * - Markdown and card notifications always need a summary.
 *
 * Inline inputs are the question of a card that has them: new content with
 * inputs asks their form, content that drops them removes the question it
 * asked (unless `reply` asks another one), and while the card keeps its
 * inputs `reply` cannot replace them.
 */
export function resolveContentUpdate(
  current: NotificationContentFields & { reply: ReplyForm | null },
  update: NotificationUpdate,
): ContentUpdate {
  const given = update.summary;
  let next: NotificationContentFields;
  if (update.content) {
    next = {
      format: update.content.format,
      title: null,
      body: null,
      summary: given !== undefined ? given : current.summary,
      markdown: update.content.markdown,
      content: update.content.content,
    };
  } else if (
    update.title !== undefined ||
    update.body !== undefined ||
    update.legacyCard !== undefined
  ) {
    const legacy =
      current.format === 'text'
        ? { title: current.title!, body: current.body, card: null }
        : current.format === 'card'
          ? contentToLegacy(current.content)
          : null;
    if (!legacy && update.title === undefined) {
      throw new ContentUpdateError(
        'title is required to turn a markdown or card notification into text',
      );
    }
    const title = update.title ?? legacy!.title;
    const body =
      update.body !== undefined ? update.body : (legacy?.body ?? null);
    const card =
      update.legacyCard !== undefined
        ? update.legacyCard
        : (legacy?.card ?? null);
    // A summary equal to what the old title gives was derived from it.
    const derived =
      legacy !== null &&
      current.summary !== null &&
      current.summary === summaryFromTitle(legacy.title);
    let summary: string | null;
    if (given !== undefined) summary = given;
    else if (!derived) summary = current.summary;
    else if (card || current.format === 'text') {
      summary = summaryFromTitle(title);
    } else summary = null;
    next = card
      ? {
          format: 'card',
          title: null,
          body: null,
          summary:
            summary ?? (given === undefined ? summaryFromTitle(title) : null),
          markdown: null,
          content: legacyToContent({ title, body, card }),
        }
      : {
          format: 'text',
          title,
          body,
          summary,
          markdown: null,
          content: null,
        };
  } else {
    next = {
      ...current,
      summary: given !== undefined ? given : current.summary,
    };
  }
  if (next.format !== 'text' && !next.summary) {
    throw new ContentUpdateError(
      'summary is required for markdown and card notifications',
    );
  }

  let reply = update.reply;
  const inputs = hasInlineInputs(next.content);
  if (update.content?.reply) {
    reply = update.content.reply;
  } else if (inputs && reply !== undefined) {
    throw new ContentUpdateError(
      'reply cannot replace the inputs written in the card; send the card with new inputs instead',
    );
  } else if (
    reply === undefined &&
    hasInlineInputs(current.content) &&
    !inputs
  ) {
    reply = null;
  }
  return { next, reply };
}
