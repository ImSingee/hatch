/**
 * Validation and compilation of notification content, shared by the
 * platform (every sender) and the CLI (offline checks before any request),
 * so both reject the same input with the same messages.
 *
 * Card markup, a JSON tree and Markdown all end as one normalized render
 * tree, held to the component catalog and the limits; the compiling itself
 * is `notification-content-compile`, which needs no dependencies. This
 * module adds what senders reach it through: the summary, the shape of a
 * JSON tree, and Markdown read with remark.
 */
import { z } from 'zod';
import {
  MAX_CARD_SOURCE_BYTES,
  MAX_SUMMARY_LENGTH,
  type ContentNode,
} from './notification-content';
import {
  ContentError,
  MAX_CONTENT_ISSUES,
  cardSourceTooLarge,
  cardTreeTooDeep,
  compileCardJsonWith,
  compileCardMarkupWith,
  compileMarkdownWith,
  type CompileOptions,
  type CompiledCard,
  type JsonNode,
} from './notification-content-compile';
import { markdownToBlocks } from './notification-markdown';

export {
  ContentError,
  formatContentIssue,
  type CompiledCard,
  type ContentIssue,
} from './notification-content-compile';

/** The platform's Markdown: remark with GitHub's extensions. */
const OPTIONS: CompileOptions = { markdownToBlocks };

// ------------------------------------------------------------------ summary

/**
 * A summary: one line of plain text, at most 200 characters. Empty
 * spellings mean none.
 */
export const summarySchema = z
  .string({ error: 'summary must be a string' })
  .trim()
  .min(1, 'summary must not be empty')
  .refine((value) => !/[\r\n]/.test(value), {
    message: 'summary must be one line, without line breaks',
  })
  .refine((value) => Array.from(value).length <= MAX_SUMMARY_LENGTH, {
    message: `summary must be at most ${MAX_SUMMARY_LENGTH} characters`,
  });

export const optionalSummarySchema = z.preprocess(
  // Blank text is an empty spelling too: it would leave a Markdown or card
  // notification without anything to show where its content is not shown.
  (value) =>
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
      ? null
      : value,
  summarySchema.nullable(),
);

// ------------------------------------------------------------------- input

const jsonNodeSchema: z.ZodType<JsonNode> = z.lazy(() =>
  z
    .object(
      {
        type: z
          .string({ error: 'type must be a component name' })
          .min(1, 'type must be a component name'),
        props: z
          .record(z.string(), z.unknown(), {
            error: 'props must be an object',
          })
          .nullish(),
        children: z
          .array(z.union([z.string(), jsonNodeSchema]), {
            error: 'children must be a list of nodes and strings',
          })
          .nullish(),
      },
      { error: 'a node must be an object with a type' },
    )
    .strict(),
);

// --------------------------------------------------------------- compiling

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Card markup to its tree and inline form; throws `ContentError`. */
export function compileCardMarkup(markup: string): CompiledCard {
  return compileCardMarkupWith(markup, OPTIONS);
}

/** A card given as a JSON tree; throws `ContentError`. */
export function compileCardTree(tree: unknown): CompiledCard {
  if (byteLength(JSON.stringify(tree) ?? '') > MAX_CARD_SOURCE_BYTES) {
    throw cardSourceTooLarge('the card tree');
  }
  // Before the shape checks, which read the tree recursively.
  const tooDeep = cardTreeTooDeep(tree);
  if (tooDeep) throw new ContentError([tooDeep]);
  const parsed = jsonNodeSchema.safeParse(tree);
  if (!parsed.success) {
    throw new ContentError(
      parsed.error.issues.slice(0, MAX_CONTENT_ISSUES).map((problem) => ({
        message: problem.message,
        path: problem.path.join('.') || 'card',
      })),
    );
  }
  return compileCardJsonWith(parsed.data, OPTIONS);
}

/**
 * A card as senders give it: markup, or a JSON tree (an object with a
 * `type`). A JSON string holding a tree is read as the tree.
 */
export function compileCard(input: unknown): CompiledCard {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{')) {
      let tree: unknown;
      try {
        tree = JSON.parse(trimmed);
      } catch {
        throw new ContentError([
          { message: 'card starts with "{" but is not valid JSON' },
        ]);
      }
      return compileCardTree(tree);
    }
    return compileCardMarkup(input);
  }
  return compileCardTree(input);
}

/** Markdown source to its tree; throws `ContentError`. */
export function compileMarkdown(source: string): ContentNode {
  return compileMarkdownWith(source, OPTIONS);
}
