import { createContext, useContext } from 'react';

const InsideDeskShell = createContext(false);

export const InsideDeskShellProvider = InsideDeskShell.Provider;

/**
 * Whether the caller renders on the signed-in desk's stage. Fallback screens
 * (not found, loading, errors) show up both there and on their own, and lay
 * themselves out differently in each place.
 */
export function useInsideDeskShell() {
  return useContext(InsideDeskShell);
}

/**
 * How a `DeskWindow` is framed. `desk`: a window floating on the desk.
 * `host`: the page fills a native window that brings its own frame (the macOS
 * app's sidebar layout), so it drops its radius, shadow, minimise and close,
 * and its title bar moves the native window.
 */
export type WindowFrame = 'desk' | 'host';

const WindowFrameContext = createContext<WindowFrame>('desk');

export const WindowFrameProvider = WindowFrameContext.Provider;

export function useWindowFrame() {
  return useContext(WindowFrameContext);
}

/**
 * Whether the open window fills the whole screen, with the menu bar hidden
 * until the pointer reaches the top edge. Only the desk shell provides it;
 * elsewhere (standalone pages, the macOS app) windows cannot maximize.
 */
export type WindowMaximize = { maximized: boolean; toggle: () => void };

const WindowMaximizeContext = createContext<WindowMaximize | null>(null);

export const WindowMaximizeProvider = WindowMaximizeContext.Provider;

export function useWindowMaximize() {
  return useContext(WindowMaximizeContext);
}
