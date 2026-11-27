import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { canRunApp } from '~components/apps/app-view-policy';
import { useErrorText, useI18n } from '~i18n';
import { appViewQueryOptions } from '~queries/apps';
import { useAppSessionStore, useAppSessions } from './app-sessions';
import { DESK_HOME } from './paths';

/**
 * What the dock and the macOS sidebar do with running Apps: find an App's
 * session, quit it, or show it beside the window in front.
 */
export function useSessionActions() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessionStore = useAppSessionStore();
  const { sessions, front } = useAppSessions();

  const sessionOf = (appId: string, slug: string) =>
    sessions.find((s) => (s.appId ? s.appId === appId : s.slug === slug));

  const quit = (slug: string) => {
    // Leave the App's window first, so the stage never shows it empty.
    if (front === slug) {
      void navigate({ to: DESK_HOME }).then(() => sessionStore.quit(slug));
    } else {
      sessionStore.quit(slug);
    }
  };

  // Read the App's live details before showing it beside: nothing running
  // is stopped for an App that cannot open, and the new frame's "has update"
  // baseline is the deployment it loads.
  const openBeside = async (appId: string, slug: string, route: string) => {
    // Reuse only this App's own session: another App may have run under the
    // slug before a rename.
    const running = sessionOf(appId, slug);
    if (running && (!appId || !running.appId || running.appId === appId)) {
      sessionStore.openBeside(running.slug, {
        appId: running.appId ?? appId,
        revision: running.revision ?? null,
      });
      return;
    }
    try {
      const app = await queryClient.fetchQuery({
        ...appViewQueryOptions(slug),
        staleTime: 0,
      });
      if (!canRunApp(app)) {
        toast.error(t('dock.openBesideUnavailable'));
        return;
      }
      sessionStore.openBeside(app.slug, {
        appId: app.id,
        revision: app.deploymentRevision,
        route,
      });
    } catch (error) {
      toast.error(errorText(error, 'dock.openBesideFailed'));
    }
  };

  return { sessions, front, sessionOf, quit, openBeside };
}
