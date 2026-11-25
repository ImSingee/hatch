/**
 * Markdown to render tree, on the platform and in the CLI (never on the
 * phone or in the web bundle: readers get the compiled tree). GitHub
 * flavoured: headings, emphasis, strikethrough, inline code, code blocks,
 * ordered, bullet and task lists, quotes, links, tables and rules. Images
 * become links (a notification never loads a picture, which would reveal
 * the reader) and raw HTML is shown as the text it is.
 *
 * The result is not validated here; `notification-content-schema` holds it
 * to the catalog and the limits like any other tree.
 */
import type {
  Definition,
  ListItem,
  Parent as MdParent,
  PhrasingContent,
  Root,
  RootContent,
} from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import {
  DOCUMENT_ROOT,
  type ContentChild,
  type ContentNode,
} from './notification-content';
import { isNotificationUrl } from './notification-url';

const parser = unified().use(remarkParse).use(remarkGfm);

const TITLE_SIZES = ['xl', 'lg', 'md', 'sm', 'sm', 'sm'] as const;

type Context = { definitions: Map<string, Definition> };

function node(
  type: string,
  props: Record<string, string | number | boolean> | undefined,
  children: ContentChild[] | undefined,
): ContentNode {
  const out: ContentNode = { type };
  if (props && Object.keys(props).length > 0) out.props = props;
  if (children && children.length > 0) out.children = children;
  return out;
}

function link(
  url: string,
  children: ContentChild[],
  fallback: string,
): ContentChild[] {
  const content = children.length > 0 ? children : [fallback || url];
  return isNotificationUrl(url) ? [node('a', { href: url }, content)] : content;
}

function inline(
  children: readonly PhrasingContent[],
  context: Context,
): ContentChild[] {
  const out: ContentChild[] = [];
  for (const child of children) {
    switch (child.type) {
      case 'text':
        // A soft line break inside a paragraph reads as a space.
        out.push(child.value.replace(/\r?\n/g, ' '));
        break;
      case 'emphasis':
        out.push(node('i', undefined, inline(child.children, context)));
        break;
      case 'strong':
        out.push(node('b', undefined, inline(child.children, context)));
        break;
      case 'delete':
        out.push(node('s', undefined, inline(child.children, context)));
        break;
      case 'inlineCode':
        out.push(node('code', undefined, [child.value]));
        break;
      case 'break':
        out.push(node('br', undefined, undefined));
        break;
      case 'html':
        out.push(child.value);
        break;
      case 'link':
        out.push(
          ...link(child.url, inline(child.children, context), child.url),
        );
        break;
      case 'image':
        out.push(...link(child.url, [], child.alt || child.url));
        break;
      case 'linkReference': {
        const definition = context.definitions.get(child.identifier);
        const content = inline(child.children, context);
        out.push(
          ...(definition
            ? link(definition.url, content, definition.url)
            : content),
        );
        break;
      }
      case 'imageReference': {
        const definition = context.definitions.get(child.identifier);
        out.push(
          ...(definition
            ? link(definition.url, [], child.alt || definition.url)
            : [child.alt ?? '']),
        );
        break;
      }
      case 'footnoteReference':
        out.push(`[^${child.label ?? child.identifier}]`);
        break;
      default:
        if ('children' in child) {
          out.push(...inline(child.children as PhrasingContent[], context));
        } else if ('value' in child && typeof child.value === 'string') {
          out.push(child.value);
        }
    }
  }
  return out;
}

const ALIGN: Record<string, string> = {
  left: 'start',
  center: 'center',
  right: 'end',
};

/**
 * A container's children: one paragraph alone reads as its inline content,
 * otherwise paragraphs become `Text` blocks next to the other blocks.
 */
function flow(children: readonly RootContent[], context: Context) {
  const [first, ...rest] = children;
  if (
    first?.type === 'paragraph' &&
    rest.every((child) => child.type !== 'paragraph')
  ) {
    return [...inline(first.children, context), ...blocks(rest, context)];
  }
  return blocks(children, context);
}

function listItem(item: ListItem, context: Context): ContentNode {
  return node(
    'Item',
    typeof item.checked === 'boolean' ? { checked: item.checked } : undefined,
    flow(item.children, context),
  );
}

function blocks(
  children: readonly RootContent[],
  context: Context,
): ContentNode[] {
  const out: ContentNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case 'heading': {
        const size = TITLE_SIZES[child.depth - 1] ?? 'sm';
        out.push(
          node(
            'Title',
            size === 'md' ? undefined : { size },
            inline(child.children, context),
          ),
        );
        break;
      }
      case 'paragraph':
        out.push(node('Text', undefined, inline(child.children, context)));
        break;
      case 'thematicBreak':
        out.push(node('Divider', undefined, undefined));
        break;
      case 'blockquote':
        out.push(node('Quote', undefined, flow(child.children, context)));
        break;
      case 'list':
        out.push(
          node(
            'List',
            child.ordered ? { ordered: true } : undefined,
            child.children.map((item) => listItem(item, context)),
          ),
        );
        break;
      case 'code':
        out.push(
          node(
            'Code',
            child.lang === 'diff' ? { language: 'diff' } : undefined,
            child.value ? [child.value] : undefined,
          ),
        );
        break;
      case 'table': {
        const aligns = child.align ?? [];
        out.push(
          node(
            'Table',
            undefined,
            child.children.map((row, rowIndex) =>
              node(
                'Tr',
                undefined,
                row.children.map((cell, cellIndex) => {
                  const align = ALIGN[aligns[cellIndex] ?? ''];
                  return node(
                    rowIndex === 0 ? 'Th' : 'Td',
                    align && align !== 'start' ? { align } : undefined,
                    inline(cell.children, context),
                  );
                }),
              ),
            ),
          ),
        );
        break;
      }
      case 'html':
        out.push(node('Text', undefined, [child.value]));
        break;
      case 'footnoteDefinition':
        out.push(
          node('Text', undefined, [
            `[^${child.label ?? child.identifier}]: `,
            ...child.children.flatMap((part) =>
              part.type === 'paragraph' ? inline(part.children, context) : [],
            ),
          ]),
        );
        break;
      case 'definition':
        break;
      default:
        if ('children' in child) {
          out.push(...blocks((child as MdParent).children, context));
        }
    }
  }
  return out;
}

function collectDefinitions(tree: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  const visit = (parent: MdParent) => {
    for (const child of parent.children) {
      if (child.type === 'definition') {
        if (!definitions.has(child.identifier)) {
          definitions.set(child.identifier, child);
        }
      } else if ('children' in child) {
        visit(child as MdParent);
      }
    }
  };
  visit(tree);
  return definitions;
}

/** The blocks a Markdown source compiles to. */
export function markdownToBlocks(source: string): ContentNode[] {
  const tree = parser.parse(source);
  return blocks(tree.children, { definitions: collectDefinitions(tree) });
}

/** A Markdown notification's tree, before validation. */
export function markdownToContent(source: string): ContentNode {
  return node(DOCUMENT_ROOT, undefined, markdownToBlocks(source));
}
