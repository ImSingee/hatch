import { Anchor, Typography } from '@mantine/core';
import { type ComponentPropsWithoutRef, memo } from 'react';
import ReactMarkdown, { type Options as MarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import classes from './chat.module.css';

function MarkdownLink(props: ComponentPropsWithoutRef<'a'>) {
  return (
    <Anchor
      {...props}
      inherit
      underline="hover"
      target="_blank"
      rel="noreferrer"
    />
  );
}

type PluginList = NonNullable<MarkdownOptions['rehypePlugins']>;
const REMARK_PLUGINS: PluginList = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: PluginList = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];
/**
 * Chat text is model output, so an image is shown only when it is one the
 * platform itself stores: a generated candidate or an App icon. Anything
 * else (notably a remote URL, which would leak a request) stays text.
 */
const PLATFORM_IMAGE_RE =
  /^\/api\/(?:images\/candidates\/[a-f0-9]{32}|app\/[A-Za-z0-9-]+\/icon(?:\?[A-Za-z0-9=&]*)?)$/;

function MarkdownImage({ src, alt }: ComponentPropsWithoutRef<'img'>) {
  if (typeof src !== 'string' || !PLATFORM_IMAGE_RE.test(src))
    return <>{alt}</>;
  return <img className={classes.markdownImage} src={src} alt={alt ?? ''} />;
}

const MARKDOWN_COMPONENTS = { a: MarkdownLink, img: MarkdownImage };

/**
 * Normalize the `\( … \)` / `\[ … \]` math delimiters that LLMs emit into the
 * `$ … $` / `$$ … $$` that remark-math understands. Display math is forced onto
 * its own block (blank lines around `$$`) so adjacent equations on soft-wrapped
 * lines can't have their `$$` pairs mismatched. Inner whitespace is trimmed
 * because remark-math treats `$ x $` (space next to the dollar) as plain text.
 */
function normalizeMath(text: string): string {
  return text
    .replace(
      /\\\[([\s\S]+?)\\\]/g,
      (_m, expr: string) => `\n\n$$\n${expr.trim()}\n$$\n\n`,
    )
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, expr: string) => `$${expr.trim()}$`);
}

// Memoized on `text`: during streaming the live bubble re-renders every token,
// but only the actively-growing text block's `text` changes. Completed blocks
// (and the whole history) keep the same string, so React.memo skips the
// expensive react-markdown + KaTeX parse for them — keeping per-token work O(1)
// instead of O(blocks).
export const Markdownish = memo(function Markdownish({
  text,
}: {
  text: string;
}) {
  if (!text.trim()) return null;
  return (
    <Typography className={classes.markdown}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </Typography>
  );
});
