/**
 * How an edit changes a notification's content: which format it ends up in,
 * what its summary becomes, and whether its question changes with it.
 */
import { hasInlineInputs } from '../../../packages/hatch-platform-api/notification-content';
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
 * - `markdown` or a card in markup or as a tree switches to that format.
 * - `title` and `body` edit a text notification. On a markdown or card
 *   notification they switch it to text, which needs `title`.
 * - The summary is the one given, else the current one, except when a
 *   markdown or card notification becomes text: its summary named the old
 *   content, and a text notification's summary replaces the body in pushes,
 *   so it is dropped unless the edit gives one. Markdown and card
 *   notifications always need a summary.
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
  } else if (update.title !== undefined || update.body !== undefined) {
    const text = current.format === 'text';
    if (!text && update.title === undefined) {
      throw new ContentUpdateError(
        'title is required to turn a markdown or card notification into text',
      );
    }
    next = {
      format: 'text',
      title: update.title ?? current.title!,
      body:
        update.body !== undefined ? update.body : text ? current.body : null,
      summary: given !== undefined ? given : text ? current.summary : null,
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
