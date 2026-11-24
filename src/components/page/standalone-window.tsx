import { ThemeIcon } from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconAppWindow } from '@tabler/icons-react';
import { type CSSProperties, type ReactNode, type Ref, useId } from 'react';
import classes from './standalone-window.module.css';

/**
 * A window on the bare desk (sign-in, device approval, not found): a title
 * bar, a padded body and an optional muted footer. Its title also names the
 * browser tab.
 */
export function StandaloneWindow({
  title,
  tile,
  width,
  footer,
  children,
}: {
  title: string;
  /** A 22 px tile before the title. */
  tile?: ReactNode;
  /** Widest the window grows, in px. */
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  useDocumentTitle(title);
  return (
    <section
      aria-labelledby={titleId}
      className={classes.window}
      style={
        width ? ({ '--sheet-width': `${width}px` } as CSSProperties) : undefined
      }
    >
      <header className={classes.titleBar}>
        {tile ?? (
          <ThemeIcon size={22} radius="xs" color="gray.7" aria-hidden>
            <IconAppWindow size={13} stroke={2.4} />
          </ThemeIcon>
        )}
        <h2 id={titleId} className={classes.title}>
          {title}
        </h2>
      </header>
      <div className={classes.body}>{children}</div>
      {footer ? <p className={classes.footer}>{footer}</p> : null}
    </section>
  );
}

/** The centred opening of a standalone window: a tile, a headline, a lead. */
export function WindowHero({
  tile,
  title,
  titleRef,
  children,
}: {
  tile?: ReactNode;
  title: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
}) {
  return (
    <div className={classes.hero}>
      {tile ? <span className={classes.heroTile}>{tile}</span> : null}
      <div className={classes.heroText}>
        <h1 ref={titleRef} tabIndex={-1} className={classes.heroTitle}>
          {title}
        </h1>
        {children ? <p className={classes.heroLead}>{children}</p> : null}
      </div>
    </div>
  );
}
