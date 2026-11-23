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
