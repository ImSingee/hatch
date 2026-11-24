import { useDocumentTitle } from '@mantine/hooks';
import { Link, type LinkProps, useRouter } from '@tanstack/react-router';
import {
  IconAppWindow,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconChevronLeft,
  IconMinus,
  IconX,
} from '@tabler/icons-react';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
} from 'react';
import { useI18n } from '~i18n';
import { useWindowFrame, useWindowMaximize } from './desk-context';
import { DESK_HOME } from './paths';
import classes from './window.module.css';

/** Where a window button leads: the route and what to call it. */
export type WindowTarget = {
  link: LinkProps;
  /** Completes "Close window, back to …". */
  label: string;
};

export type DeskWindowProps = {
  title: string;
  /**
   * The browser tab's title while this window is open. Defaults to `title`;
   * set it when the title bar does not name the page, or when the page's name
   * comes from what the window shows (an open chat, the App's own page).
   */
  documentTitle?: string;
  /** A 22 px tile shown before the title. Defaults to a neutral window tile. */
  tile?: ReactNode;
  /** Shown after the title, for a status chip. */
  badge?: ReactNode;
  /** Controls of this window, placed before the window buttons. */
  toolbar?: ReactNode;
  /** Where closing leads. Defaults to the desk. */
  closeTo?: WindowTarget;
  /** Fill the stage instead of fitting the content. */
  fill?: boolean;
  /** Widest the window grows, in px. */
  maxWidth?: number;
  children: ReactNode;
};

/**
 * Layers that sit above a window and answer Escape themselves. A closed
 * modal keeps its empty root mounted, so match what only an open one renders.
 */
const LAYERS = [
  '.mantine-Modal-content',
  '.mantine-Drawer-content',
  '.mantine-Popover-dropdown',
  '.mantine-Menu-dropdown',
  '.mantine-Combobox-dropdown',
].join(',');

function layerOpen() {
  return Array.from(document.querySelectorAll(LAYERS)).some(
    (element) => element.checkVisibility?.() ?? true,
  );
}

function isEditing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [role="textbox"]') !== null)
  );
}

/**
 * The frame every page is shown in. The window is a layout component and
 * holds no state of its own: which window is open is the URL, so closing is a
 * link, and reload, deep links and the back button work as for any page.
 * Maximizing belongs to the desk shell, so the next window opens the same
 * way. Minimise is shown but disabled until windows can wait on the desk.
 *
 * Keyboard: opening a window moves focus into it unless the page already
 * placed focus, and Escape closes it when nothing above it (a menu, a modal)
 * or inside it (a field being edited) wants the key.
 */
export function DeskWindow({
  title,
  documentTitle,
  tile,
  badge,
  toolbar,
  closeTo,
  fill = false,
  maxWidth = 1320,
  children,
}: DeskWindowProps) {
  const { t } = useI18n();
  const target: WindowTarget = closeTo ?? {
    link: { to: DESK_HOME },
    label: t('window.desk'),
  };
  const titleId = useId();
  useDocumentTitle(documentTitle || title);
  const frame = useRef<HTMLElement>(null);
  const hosted = useWindowFrame() === 'host';
  const maximizable = useWindowMaximize();
  const maximize = hosted ? null : maximizable;
  const router = useRouter();
  const close = useEffectEvent(() => {
    void router.navigate(target.link as never);
  });

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const active = document.activeElement;
    if (active && element.contains(active)) return;
    element.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    // A layer closes itself during the same event, so note whether one was
    // open before any handler ran.
    let layerWasOpen = false;
    const capture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') layerWasOpen = layerOpen();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.isComposing || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      if (layerWasOpen || isEditing(event.target)) return;
      close();
    };
    window.addEventListener('keydown', capture, true);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', capture, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, []);

  return (
    <section
      ref={frame}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={classes.window}
      data-fill={fill || undefined}
      data-frame={hosted ? 'host' : undefined}
      data-maximized={maximize?.maximized || undefined}
      style={{ '--window-max-width': `${maxWidth}px` } as CSSProperties}
    >
      <header
        className={classes.titleBar}
        // Tauri's drag script: the bar moves the native window, while its
        // links and buttons stay clickable. Inert in a browser.
        data-tauri-drag-region={hosted ? 'deep' : undefined}
        // As on a desktop, double-clicking the bar maximizes or restores.
        onDoubleClick={(event) => {
          if (!maximize) return;
          if ((event.target as Element).closest('a, button, input')) return;
          maximize.toggle();
        }}
      >
        <Link
          {...target.link}
          className={`${classes.button} ${classes.back}`}
          aria-label={t('window.backTo', { target: target.label })}
        >
          <IconChevronLeft size={18} stroke={2.4} aria-hidden />
        </Link>
        <span className={classes.tile} aria-hidden>
          {tile ?? (
            <span className={classes.defaultTile}>
              <IconAppWindow size={13} stroke={2.4} />
            </span>
          )}
        </span>
        <h1 id={titleId} className={classes.title}>
          {title}
        </h1>
        {badge ? <span className={classes.badge}>{badge}</span> : null}
        <span className={classes.spacer} />
        {toolbar ? <div className={classes.toolbar}>{toolbar}</div> : null}
        {hosted ? null : (
          <>
            <button
              type="button"
              className={`${classes.button} ${classes.wide}`}
              aria-label={t('window.minimise')}
              title={t('window.minimiseUnavailable')}
              disabled
            >
              <IconMinus size={14} stroke={2.4} aria-hidden />
            </button>
            {maximize ? (
              <button
                type="button"
                className={`${classes.button} ${classes.wide}`}
                aria-label={
                  maximize.maximized
                    ? t('window.restore')
                    : t('window.maximize')
                }
                onClick={maximize.toggle}
              >
                {maximize.maximized ? (
                  <IconArrowsDiagonalMinimize2
                    size={14}
                    stroke={2.4}
                    aria-hidden
                  />
                ) : (
                  <IconArrowsDiagonal size={14} stroke={2.4} aria-hidden />
                )}
              </button>
            ) : null}
            <Link
              {...target.link}
              className={`${classes.button} ${classes.wide}`}
              aria-label={t('window.closeBackTo', { target: target.label })}
            >
              <IconX size={14} stroke={2.4} aria-hidden />
            </Link>
          </>
        )}
      </header>
      <div className={classes.body}>{children}</div>
    </section>
  );
}
