import { type ReactNode, useState } from 'react';
import {
  InsideDeskShellProvider,
  WindowMaximizeProvider,
} from './desk-context';
import { DeskGround } from './desk-ground';
import { Dock } from './dock';
import type { DockOpenItem } from './dock-item';
import { MenuBar } from './menu-bar';
import { TabBar } from './tab-bar';
import classes from './desk-shell.module.css';

/** A per-browser convenience: windows open the way the last one was left. */
const MAXIMIZED_KEY = 'hatch.desk.windowMaximized';

function readMaximized() {
  try {
    return localStorage.getItem(MAXIMIZED_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeMaximized(maximized: boolean) {
  try {
    if (maximized) localStorage.setItem(MAXIMIZED_KEY, 'true');
    else localStorage.removeItem(MAXIMIZED_KEY);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

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
 * row under the stage. A maximized window fills the screen, and with a mouse
 * the menu bar likewise waits above the top edge.
 */
export function DeskShell({
  view,
  tabDestination,
  openItems,
  children,
}: DeskShellProps) {
  const [maximized, setMaximized] = useState(readMaximized);
  const toggleMaximized = () => {
    storeMaximized(!maximized);
    setMaximized(!maximized);
  };

  return (
    <DeskGround
      className={classes.shell}
      data-view={view}
      data-tabs={tabDestination ? 'true' : undefined}
      data-maximized={view === 'window' && maximized ? 'true' : undefined}
    >
      <a href="#desk-stage" className={classes.skip}>
        Skip to content
      </a>
      <div aria-hidden className={classes.menuEdge} />
      <div className={classes.menuBar}>
        <MenuBar />
      </div>
      <main id="desk-stage" className={classes.stage}>
        <InsideDeskShellProvider value>
          <WindowMaximizeProvider
            value={{ maximized, toggle: toggleMaximized }}
          >
            {children}
          </WindowMaximizeProvider>
        </InsideDeskShellProvider>
      </main>
      <footer className={classes.dock}>
        <div aria-hidden className={classes.dockEdge} />
        <div aria-hidden className={classes.dockHandle} />
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
