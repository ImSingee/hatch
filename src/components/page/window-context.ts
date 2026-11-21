import { createContext, useContext } from 'react';

const InsideWindow = createContext(false);

/** Marks content that already sits inside a window's body. */
export const InsideWindowProvider = InsideWindow.Provider;

/**
 * Whether the caller renders inside a window. A fallback (an error, a
 * missing page) in a nested route fills its parent window's body instead
 * of opening a window of its own.
 */
export function useInsideWindow() {
  return useContext(InsideWindow);
}
