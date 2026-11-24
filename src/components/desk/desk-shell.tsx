import type { ReactNode } from 'react';
import { InsideDeskShellProvider } from './desk-context';
import { DeskGround } from './desk-ground';
import { Dock } from './dock';
import type { DockOpenItem } from './dock-item';
import { MenuBar } from './menu-bar';
import { TabBar } from './tab-bar';
import classes from './desk-shell.module.css';

type DeskShellProps = {
  /** `home`: the desk itself is showing; `window`: a page is open in one. */
  view: 'home' | 'window';
  /**
   * Below 560 wide a window takes the whole stage. Tab destinations keep the
   * tab bar; every other window gives its room to the page.
   */
  tabDestination: boolean;
  /** Dock items whose window is open. */
  openItems: readonly DockOpenItem[];
  children: ReactNode;
};

/**
 * The desk every signed-in page lives on: menu bar on top, then the stage
 * (the desk home, or one window) down to the bottom edge. With a mouse the
 * dock floats over the stage and stays below the edge until the pointer
 * reaches the bottom or keyboard focus enters it; on touch it keeps its own
 * row under the stage.
 */
export function DeskShell({
  view,
  tabDestination,
  openItems,
  children,
}: DeskShellProps) {
  return (
    <DeskGround
      className={classes.shell}
      data-view={view}
      data-tabs={tabDestination ? 'true' : undefined}
    >
      <a href="#desk-stage" className={classes.skip}>
        Skip to content
      </a>
      <div className={classes.menuBar}>
        <MenuBar />
      </div>
      <main id="desk-stage" className={classes.stage}>
        <InsideDeskShellProvider value>{children}</InsideDeskShellProvider>
      </main>
      <footer className={classes.dock}>
        <div aria-hidden className={classes.dockEdge} />
        <div className={classes.dockPanel}>
          <Dock openItems={openItems} />
        </div>
      </footer>
      <footer className={classes.tabs}>
        <TabBar />
      </footer>
    </DeskGround>
  );
}
