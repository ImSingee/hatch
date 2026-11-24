import { Box } from '@mantine/core';
import dayjs from 'dayjs';
import { type ReactNode, useEffect, useRef } from 'react';
import classes from './desk-home.module.css';

type DeskHomeProps = {
  /** The page heading: the greeting. */
  title: ReactNode;
  /** Shown above the heading; defaults to today's date. */
  eyebrow?: ReactNode;
  /** One line under the heading. */
  description?: ReactNode;
  /** Actions beside the heading (new App, all Apps). */
  actions?: ReactNode;
  /** The widget toolbar: dashboard, refresh, edit. */
  toolbar?: ReactNode;
  /** While editing, the editor heading replaces the heading and toolbar. */
  editor?: ReactNode;
  /** While editing, the panel beside the widgets (add widgets, refresh). */
  editorPanel?: ReactNode;
  editing?: boolean;
  /** The ultrawide desk's left column, under the heading. */
  today?: ReactNode;
  /** The ultrawide desk's right column. */
  companion?: ReactNode;
  /** The desk widgets. */
  children: ReactNode;
};

/**
 * The desk with no window open, straight on the ground. One DOM tree serves
 * every width; CSS places the parts:
 *
 * - default: heading and toolbar in a row, then the widgets;
 * - ultrawide: a today column, the widgets and a companion column;
 * - editing: the editor heading and widgets, with the editor panel beside
 *   them or, when narrow, below.
 *
 * The widgets keep the same parent in every arrangement, so switching modes
 * or widths never reloads a running widget.
 */
export function DeskHome({
  title,
  eyebrow,
  description,
  actions,
  toolbar,
  editor,
  editorPanel,
  editing = false,
  today,
  companion,
  children,
}: DeskHomeProps) {
  const root = useRef<HTMLDivElement>(null);

  // Arriving at the desk (a window was closed) starts keyboard users here
  // rather than on a control that no longer exists.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    element.focus({ preventScroll: true });
  }, []);

  return (
    <Box
      ref={root}
      tabIndex={-1}
      className={classes.root}
      data-editing={editing || undefined}
      data-companion={companion ? 'true' : undefined}
    >
      <div className={classes.layout}>
        {editing ? (
          <div className={classes.editor}>{editor}</div>
        ) : (
          <>
            <header className={classes.heading}>
              <span className={classes.eyebrow}>
                {eyebrow ?? dayjs().format('dddd, MMMM D')}
              </span>
              <h1 className={classes.title}>{title}</h1>
              {description ? (
                <p className={classes.description}>{description}</p>
              ) : null}
              {actions ? (
                <div className={classes.headingActions}>{actions}</div>
              ) : null}
            </header>
            {toolbar ? <div className={classes.toolbar}>{toolbar}</div> : null}
            {today ? <div className={classes.today}>{today}</div> : null}
          </>
        )}
        <section aria-label="Widgets" className={classes.widgets}>
          {children}
        </section>
        {!editing && companion ? (
          <div className={classes.companion}>{companion}</div>
        ) : null}
        {editing && editorPanel ? (
          <div className={classes.panel}>{editorPanel}</div>
        ) : null}
      </div>
    </Box>
  );
}
