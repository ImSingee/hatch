/**
 * Markdown to card blocks with NSH's own reader (`TextView.parse`), mapped
 * to the blocks the platform's remark reader makes
 * (`packages/hatch-platform-api/notification-markdown.ts`): GitHub
 * flavoured, raw HTML as text, no formulas or alerts, images as links.
 */
import { TextView } from 'nsh/base';
import type { ContentChild, ContentNode } from './content/catalog.gen';
import { isNotificationUrl } from './content/url.gen';

/** The reader's document as NSH declares it. */
type Document = ReturnType<typeof TextView.parse>;
type Block = Document['blocks'][number];
type Inline = Extract<Block, { type: 'paragraph' }>['content'][number];

const TITLE_SIZES = ['xl', 'lg', 'md', 'sm', 'sm', 'sm'] as const;

const ALIGN: Record<string, string> = {
  left: 'start',
  center: 'center',
  right: 'end',
};

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

function inline(children: readonly Inline[]): ContentChild[] {
  const out: ContentChild[] = [];
  for (const child of children) {
    switch (child.type) {
      case 'text':
        // A soft line break inside a paragraph reads as a space.
        out.push(child.text.replace(/\r?\n/g, ' '));
        break;
      case 'emphasis':
        out.push(node('i', undefined, inline(child.content)));
        break;
      case 'strong':
        out.push(node('b', undefined, inline(child.content)));
        break;
      case 'strikethrough':
        out.push(node('s', undefined, inline(child.content)));
        break;
      case 'code':
        out.push(node('code', undefined, [child.code]));
        break;
      case 'break':
        out.push(node('br', undefined, undefined));
        break;
      case 'link':
        out.push(...link(child.url, inline(child.content), child.url));
        break;
      case 'image':
        out.push(...link(child.src, [], child.alt || child.src));
        break;
      case 'footnoteReference':
        out.push(`[^${child.label}]`);
        break;
      case 'keyboard':
        out.push(child.text);
        break;
      case 'math':
        out.push(child.tex);
        break;
      case 'custom':
        out.push(child.text ?? '');
        break;
      default:
        if ('content' in child) out.push(...inline(child.content));
    }
  }
  return out;
}

/** A container's children: one paragraph alone reads as its inline
 * content, otherwise paragraphs become `Text` blocks. */
function flow(children: readonly Block[]): ContentChild[] {
  const [first, ...rest] = children;
  if (
    first?.type === 'paragraph' &&
    rest.every((child) => child.type !== 'paragraph')
  ) {
    return [...inline(first.content), ...blocks(rest)];
  }
  return blocks(children);
}

function blocks(children: readonly Block[]): ContentNode[] {
  const out: ContentNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case 'heading': {
        const size = TITLE_SIZES[child.level - 1] ?? 'sm';
        out.push(
          node(
            'Title',
            size === 'md' ? undefined : { size },
            inline(child.content),
          ),
        );
        break;
      }
      case 'paragraph':
        out.push(node('Text', undefined, inline(child.content)));
        break;
      case 'rule':
        out.push(node('Divider', undefined, undefined));
        break;
      case 'blockquote':
        out.push(node('Quote', undefined, flow(child.children)));
        break;
      case 'list':
        out.push(
          node(
            'List',
            child.ordered ? { ordered: true } : undefined,
            child.items.map((item) =>
              node(
                'Item',
                typeof item.checked === 'boolean'
                  ? { checked: item.checked }
                  : undefined,
                flow(item.children),
              ),
            ),
          ),
        );
        break;
      case 'codeBlock':
        out.push(
          node(
            'Code',
            child.language === 'diff' ? { language: 'diff' } : undefined,
            child.code ? [child.code] : undefined,
          ),
        );
        break;
      case 'table': {
        const aligns = child.align ?? [];
        const row = (
          cells: readonly { content: Inline[] }[],
          type: 'Th' | 'Td',
        ) =>
          node(
            'Tr',
            undefined,
            cells.map((cell, index) => {
              const align = ALIGN[aligns[index] ?? ''];
              return node(
                type,
                align && align !== 'start' ? { align } : undefined,
                inline(cell.content),
              );
            }),
          );
        out.push(
          node('Table', undefined, [
            row(child.head, 'Th'),
            ...(child.rows ?? []).map((cells) => row(cells, 'Td')),
          ]),
        );
        break;
      }
      case 'details':
        out.push(...blocks(child.children));
        break;
      case 'math':
        out.push(node('Text', undefined, [child.tex]));
        break;
      default:
        break;
    }
  }
  return out;
}

/** The blocks a Markdown source reads as, before the catalog checks them. */
export function markdownToBlocks(source: string): ContentNode[] {
  const document = TextView.parse(source, {
    math: false,
    html: false,
    alerts: false,
  });
  const out = blocks(document.blocks);
  // Footnotes, which the platform's reader keeps where they are written,
  // come at the end here.
  for (const note of document.footnotes ?? []) {
    out.push(
      node('Text', undefined, [
        `[^${note.label}]: `,
        ...note.children.flatMap((part) =>
          part.type === 'paragraph' ? inline(part.content) : [],
        ),
      ]),
    );
  }
  return out;
}
