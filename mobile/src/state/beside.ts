import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { useSession } from './session';

/** An App shown beside the screen in front. */
export type BesideApp = {
  id: string;
  slug: string;
  name: string;
  /** How its frontend runs (`AppSummary.runtime`). */
  runtime: 'native' | 'web' | null;
};

const besideKey = (origin: string | null) => [origin, 'beside-app'];
const frontKey = (origin: string | null) => [origin, 'front-apps'];

/**
 * The App beside the screen in front, as on the web Desk: at most one, put
 * there only by "Open beside", and kept while the front screen changes.
 * Hiding it (or a window too narrow for two) leaves it running; closing it
 * stops it. It lives in memory with the instance's other queries and is
 * cleared with them.
 */
export function useBesideApp() {
  const { origin } = useSession();
  const client = useQueryClient();
  const { data = null } = useQuery<BesideApp | null>({
    queryKey: besideKey(origin),
    queryFn: skipToken,
    initialData: null,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const set = useCallback(
    (app: BesideApp | null) =>
      client.setQueryData<BesideApp | null>(besideKey(origin), app),
    [client, origin],
  );
  return [data, set] as const;
}

/**
 * Apps the screens in front show now. An App has one view: while the front
 * shows the App that is beside, the beside column steps aside.
 */
export function useFrontApps() {
  const { origin } = useSession();
  const { data = [] } = useQuery<string[]>({
    queryKey: frontKey(origin),
    queryFn: skipToken,
    initialData: [],
    gcTime: Infinity,
    staleTime: Infinity,
  });
  return data;
}

/**
 * Registers an App the screen in front shows, for `useFrontApps`. Only while
 * that screen has focus: a screen another one covers keeps its place in the
 * stack, but it no longer shows its App, which may then be beside.
 */
export function useShowsApp(appId: string | null | undefined) {
  const { origin } = useSession();
  const client = useQueryClient();
  const id = useIsFocused() ? appId : null;
  useEffect(() => {
    if (!id) return;
    const key = frontKey(origin);
    client.setQueryData<string[]>(key, (ids = []) => [...ids, id]);
    return () => {
      client.setQueryData<string[]>(key, (ids = []) => {
        // One screen leaves; another screen of the same App stays.
        const index = ids.indexOf(id);
        return ids.filter((_, at) => at !== index);
      });
    };
  }, [client, origin, id]);
}
