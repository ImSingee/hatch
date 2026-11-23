import { createContext, useContext, type PropsWithChildren } from 'react';
import { accentOf, defaultAccent, type Accent, type AccentName } from './theme';

const AccentContext = createContext<Accent>(accentOf(defaultAccent));

/**
 * The single place the accent enters the app. Every accent colour on screen
 * comes from `useAccent()`, so changing `name` here recolours everything.
 */
export function AccentProvider({
  name,
  children,
}: PropsWithChildren<{ name: AccentName }>) {
  return (
    <AccentContext.Provider value={accentOf(name)}>
      {children}
    </AccentContext.Provider>
  );
}

export function useAccent(): Accent {
  return useContext(AccentContext);
}
