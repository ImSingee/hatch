/**
 * What a card or Markdown tree shows, independent of the renderer that
 * draws it: the controls and landmarks an assistive technology finds, in
 * order, and the texts a reader sees. The Desk, the phone and `@hatch/ui`
 * each draw the same tree their own way; comparing what each renders with
 * this outline holds them to the same structure. Dependency-free.
 *
 * The outline is of a card shown without a live form (inputs show the
 * sender's defaults, nothing is answered) and with every link openable.
 * Times are left out: each renderer formats them in its reader's language.
 */
import {
  inlineText,
  isNode,
  nodeChildren,
  propBool,
  propString,
  type ContentChild,
  type ContentNode,
} from './notification-content';

export type OutlineEntry =
  | {
      role:
        | 'heading'
        | 'link'
        | 'button'
        | 'textbox'
        | 'progressbar'
        | 'columnheader'
        | 'cell';
      name: string;
    }
  | { role: 'radio' | 'checkbox'; name: string; checked: boolean };

export type ContentOutline = {
  /** Controls and landmarks, in reading order. */
  entries: OutlineEntry[];
  /** Every text a reader sees, whitespace collapsed; order not kept. */
  texts: string[];
};

/** Whitespace collapsed and trimmed, as every renderer lays text out. */
export function outlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Inline content as text, times left out. */
function textOf(children: readonly ContentChild[]): string {
  return outlineText(
    children
      .map((child) => {
        if (typeof child === 'string') return child;
        if (child.type === 'time') return ' ';
        if (child.type === 'br') return ' ';
        return textOf(nodeChildren(child));
      })
      .join(''),
  );
}

export function contentOutline(content: ContentNode): ContentOutline {
  const entries: OutlineEntry[] = [];
  const texts: string[] = [];
  const text = (value: string | undefined) => {
    const shown = outlineText(value ?? '');
    if (shown) texts.push(shown);
  };
  const entry = (value: OutlineEntry) => entries.push(value);

  /** Text runs inside inline content, and its links. */
  const inline = (children: readonly ContentChild[]) => {
    text(textOf(children));
    for (const child of children) {
      if (!isNode(child)) continue;
      if (child.type === 'a') {
        entry({ role: 'link', name: textOf(nodeChildren(child)) });
      } else {
        inline(nodeChildren(child));
      }
    }
  };

  /** Flow content: inline runs and blocks. */
  const flow = (children: readonly ContentChild[]) => {
    for (const child of children) {
      if (typeof child === 'string') text(child);
      else visit(child);
    }
  };

  const visit = (node: ContentNode) => {
    const children = nodeChildren(node);
    switch (node.type) {
      case 'Card':
        text(propString(node, 'status'));
        text(propString(node, 'flag'));
        flow(children);
        return;
      case 'Title':
        entry({ role: 'heading', name: textOf(children) });
        inline(children);
        return;
      case 'Collapse': {
        const summary = propString(node, 'summary') ?? '';
        entry({ role: 'button', name: outlineText(summary) });
        text(summary);
        return; // Closed: its content is not shown.
      }
      case 'a':
      case 'b':
      case 'i':
      case 's':
      case 'code':
        // Inline content among flow content.
        inline([node]);
        return;
      case 'Text':
      case 'Caption':
      case 'Badge':
        inline(children);
        return;
      case 'time':
      case 'br':
        return;
      case 'Field':
        text(propString(node, 'label'));
        inline(children);
        return;
      case 'Step':
        inline(children);
        text(propString(node, 'detail'));
        return;
      case 'Stat':
        text(propString(node, 'value'));
        text(propString(node, 'label'));
        text(propString(node, 'delta'));
        return;
      case 'Progress':
        entry({
          role: 'progressbar',
          name: outlineText(propString(node, 'label') ?? ''),
        });
        text(propString(node, 'label'));
        text(propString(node, 'value'));
        return;
      case 'Item': {
        const checked = node.props?.checked;
        if (typeof checked === 'boolean') {
          entry({ role: 'checkbox', name: textOf(children), checked });
        }
        flow(children);
        return;
      }
      case 'Th':
      case 'Td':
        entry({
          role: node.type === 'Th' ? 'columnheader' : 'cell',
          name: textOf(children),
        });
        inline(children);
        return;
      case 'Quote':
        text(propString(node, 'author'));
        text(propString(node, 'location'));
        flow(children);
        return;
      case 'Code':
        for (const line of inlineText(children).split('\n')) text(line);
        return;
      case 'Trend':
        text(propString(node, 'label'));
        return;
      case 'Callout':
        text(propString(node, 'title'));
        flow(children);
        return;
      case 'Choice': {
        text(propString(node, 'label'));
        text(propString(node, 'description'));
        const role = propBool(node, 'multiple') ? 'checkbox' : 'radio';
        for (const option of children.filter(isNode)) {
          if (option.type !== 'Option') continue;
          const label = textOf(nodeChildren(option));
          entry({ role, name: label, checked: propBool(option, 'default') });
          text(label);
          text(propString(option, 'note'));
          text(propString(option, 'badge'));
        }
        return;
      }
      case 'Buttons':
        text(propString(node, 'label'));
        text(propString(node, 'description'));
        flow(children);
        return;
      case 'Button': {
        const label =
          textOf(children) || outlineText(propString(node, 'href') ?? '');
        entry({ role: 'button', name: label });
        text(label);
        return;
      }
      case 'Input':
        entry({
          role: 'textbox',
          name: outlineText(propString(node, 'label') ?? ''),
        });
        text(propString(node, 'label'));
        text(propString(node, 'description'));
        return;
      case 'Submit':
        return; // Shown only while answering.
      default:
        flow(children);
    }
  };

  visit(content);
  return { entries, texts };
}
