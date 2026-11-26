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
  /**
   * Where the window is. `front`: the page the URL opens; it names the tab,
   * takes focus when it comes forward and answers Escape. `beside`: shown
   * next to the window in front (a running App); it answers Escape only
   * while focus is inside it. `hidden`: kept mounted but not shown (a
   * running App waiting on the desk).
   */
  placement?: WindowPlacement;
  /**
   * Makes Minimise available: the window waits on the desk instead of
   * closing. Called by Minimise, and by Escape and the back button, which
   * then minimise rather than close. A `front` window still leads to
   * `closeTo` afterwards.
   */
  onMinimise?: () => void;
  /**
   * Called when Close is chosen. A `front` window then leads to `closeTo`;
   * a `beside` window only calls this.
   */
  onClose?: () => void;
  children: ReactNode;
};

export type WindowPlacement = 'front' | 'beside' | 'hidden';

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
 * holds no state of its own: which window is in front is the URL, so closing
 * is a link, and reload, deep links and the back button work as for any
 * page. Maximizing belongs to the desk shell, so the next window opens the
 * same way. Minimise is available where the window can wait on the desk (a
 * running App, see `RunningApps`); elsewhere it is shown but disabled.
 *
 * Keyboard: a window coming to the front moves focus into it unless the page
 * already placed focus, and Escape closes (or minimises) the window that has
 * focus, else the one in front, when nothing above it (a menu, a modal) or
 * inside it (a field being edited) wants the key.
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
  placement = 'front',
  onMinimise,
  onClose,
  children,
}: DeskWindowProps) {
  const { t } = useI18n();
  const target: WindowTarget = closeTo ?? {
    link: { to: DESK_HOME },
    label: t('window.desk'),
  };
  const titleId = useId();
  const front = placement === 'front';
  const beside = placement === 'beside';
  // Only the window in front names the tab ('' leaves the title alone).
  useDocumentTitle(front ? documentTitle || title : '');
  const frame = useRef<HTMLElement>(null);
  const hosted = useWindowFrame() === 'host';
  const maximizable = useWindowMaximize();
  // The shell maximizes every window on screen; the one in front holds the
  // button.
  const maximized = !hosted && Boolean(maximizable?.maximized);
  const maximize = hosted || beside ? null : maximizable;
  const router = useRouter();
  const leave = () => {
    void router.navigate(target.link as never);
  };
  // Escape: a window that can wait on the desk minimises, others close.
  const dismiss = useEffectEvent(() => {
    if (onMinimise) onMinimise();
    if (!beside) leave();
  });

  useEffect(() => {
    if (!front) return;
    const element = frame.current;
    if (!element) return;
    const active = document.activeElement;
    if (active && element.contains(active)) return;
    element.focus({ preventScroll: true });
  }, [front]);

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
      // The key belongs to the window that has focus, else to the front.
      const owner = (event.target as Element | null)?.closest?.(
        '[data-window-placement]',
      );
      if (owner ? owner !== frame.current : !front) return;
      dismiss();
    };
    if (placement === 'hidden') return;
    window.addEventListener('keydown', capture, true);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', capture, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, [placement, front]);

  return (
    <section
      ref={frame}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={classes.window}
      hidden={placement === 'hidden'}
      data-window-placement={placement}
      data-fill={fill || undefined}
      data-frame={hosted ? 'host' : undefined}
      data-maximized={maximized || undefined}
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
        {beside ? null : (
          <Link
            {...target.link}
            className={`${classes.button} ${classes.back}`}
            aria-label={t('window.backTo', { target: target.label })}
            onClick={onMinimise}
          >
            <IconChevronLeft size={18} stroke={2.4} aria-hidden />
          </Link>
        )}
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
            {onMinimise ? (
              <button
                type="button"
                className={`${classes.button} ${classes.wide}`}
                aria-label={t('window.minimise')}
                onClick={() => {
                  onMinimise();
                  if (!beside) leave();
                }}
              >
                <IconMinus size={14} stroke={2.4} aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                className={`${classes.button} ${classes.wide}`}
                aria-label={t('window.minimise')}
                title={t('window.minimiseUnavailable')}
                disabled
              >
                <IconMinus size={14} stroke={2.4} aria-hidden />
              </button>
            )}
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
            {beside ? (
              <button
                type="button"
                className={`${classes.button} ${classes.wide}`}
                aria-label={t('window.closeNamed', { name: title })}
                onClick={onClose}
              >
                <IconX size={14} stroke={2.4} aria-hidden />
              </button>
            ) : (
              <Link
                {...target.link}
                className={`${classes.button} ${classes.wide}`}
                aria-label={t('window.closeBackTo', { target: target.label })}
                onClick={onClose}
              >
                <IconX size={14} stroke={2.4} aria-hidden />
              </Link>
            )}
          </>
        )}
      </header>
      <div className={classes.body}>{children}</div>
    </section>
  );
}
