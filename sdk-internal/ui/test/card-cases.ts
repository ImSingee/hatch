/**
 * What the `card` NSH fixture checks the library against, from the
 * platform's own compiler: each notification example with the outline the
 * platform gives it, and Markdown sources with the blocks the platform's
 * reader makes. Written into the fixture's copy before `nsh test` runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CARD_EXAMPLES,
  MARKDOWN_EXAMPLE,
} from '../../../packages/hatch-platform-api/notification-content-examples';
import { contentOutline } from '../../../packages/hatch-platform-api/notification-content-outline';
import { compileCardMarkup } from '../../../packages/hatch-platform-api/notification-content-schema';

/** Markdown the platform and NSH's reader must read alike. */
export const MARKDOWN_SOURCES: readonly string[] = [
  MARKDOWN_EXAMPLE.markdown!,
  '# One\n\n## Two\n\n### Three\n\n#### Four',
  'Text with *emphasis*, **strong**, ~~struck~~ and `code`,\nsoft-broken.\\\nHard break.',
  '- one\n- two\n  - nested\n\n1. first\n2. second',
  '- [x] done\n- [ ] open',
  '> A quote\n>\n> with two paragraphs',
  '```diff\n- old\n+ new\n```\n\n```\nplain\n```',
  '| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |',
  '[a link](https://example.com/page) and <https://example.com/bare>',
  '![a picture](https://example.com/p.png)',
  'Some <b>raw html</b> here',
  '---\n\nAfter a rule',
];

export function writeCardCases(appDir: string): void {
  const cases = CARD_EXAMPLES.map((example) => {
    const { content } = compileCardMarkup(example.markup!);
    return {
      id: example.id,
      markup: example.markup!,
      outline: contentOutline(content),
    };
  });
  const markdown = MARKDOWN_SOURCES.map((source) => ({
    source,
    blocks:
      compileCardMarkup(
        `<Card><Markdown><![CDATA[${source}]]></Markdown></Card>`,
      ).content.children ?? [],
  }));
  fs.writeFileSync(path.join(appDir, 'cases.json'), JSON.stringify(cases));
  fs.writeFileSync(
    path.join(appDir, 'markdown.json'),
    JSON.stringify(markdown),
  );
}
