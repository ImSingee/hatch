import {
  ClientOnly,
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools';
import { TanStackDevtools } from '@tanstack/react-devtools';
import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps,
} from '@mantine/core';
import { Toaster } from 'sonner';
import { NavigationProgress } from '@mantine/nprogress';
import { ModalsProvider } from '@mantine/modals';
import type { QueryClient } from '@tanstack/react-query';
import appCss from '~styles.css?url';
// Starts the UI language (and <html lang>) before any route renders.
import { useI18n } from '~i18n';
import { AccentSync } from '~components/system/accent-sync';
import { LocaleSync } from '~components/system/locale-sync';
import { DESKTOP_HOST_BOOT_SCRIPT } from '~components/desktop-host/host';
import {
  ACCENT_BOOT_SCRIPT,
  ACCENT_CSS,
  NATIVE_HOST_BOOT_SCRIPT,
  appCssVariablesResolver,
  deskThemeFor,
  useAccent,
} from '~ui/theme';

/**
 * One SPA document serves every page, so a per-route policy cannot cover
 * in-app navigation. Send only the origin as Referer: URLs such as
 * /cli/authorize?user_code=… never reach logs, while same-origin Origin
 * headers (checked by the App data API) stay intact. `no-referrer` would send
 * `Origin: null` on same-origin form posts (and, per the Fetch standard, other
 * non-CORS posts), including from srcdoc widgets that inherit this policy.
 */
const REFERRER_POLICY = 'strict-origin';

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  // The shell is still prerendered, but every matched route (including its
  // beforeLoad/loader hooks) must execute in the browser in global SPA mode.
  // Setting this on the root also applies the boundary to all descendants.
  ssr: false,
  // Sent with every shell response, whatever path or casing loaded it, so the
  // policy applies before the first asset request. Server routes (APIs, App
  // runtime) return their own responses and keep their own policies.
  headers: () => ({ 'Referrer-Policy': REFERRER_POLICY }),
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      // Same policy for a shell served without the response header.
      {
        name: 'referrer',
        content: REFERRER_POLICY,
      },
      {
        title: 'Hatch',
      },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/x-icon',
        sizes: '16x16 24x24 32x32 48x48 64x64',
        href: '/favicon.ico?v=20260828',
      },
      {
        rel: 'manifest',
        href: '/manifest.json',
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),

  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const accent = useAccent();
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <HeadContent />
        <ColorSchemeScript forceColorScheme="light" />
        <style dangerouslySetInnerHTML={{ __html: ACCENT_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: ACCENT_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: NATIVE_HOST_BOOT_SCRIPT }} />
        <script
          dangerouslySetInnerHTML={{ __html: DESKTOP_HOST_BOOT_SCRIPT }}
        />
      </head>
      <body>
        <MantineProvider
          theme={deskThemeFor(accent)}
          cssVariablesResolver={appCssVariablesResolver}
          forceColorScheme="light"
        >
          <AccentSync />
          <LocaleSync />
          <ModalsProvider>{children}</ModalsProvider>

          {/* Client-only: the shell is prerendered in English, and hydration
              keeps prerendered attributes, so the translated label would
              never replace it. */}
          <ClientOnly>
            <Toaster
              position="top-center"
              richColors
              containerAriaLabel={t('nav.notifications')}
            />
          </ClientOnly>
          {/* A picture, not a control: it stays at the top edge even while
              idle, where the pointer must reach what is underneath. */}
          <NavigationProgress className="desk-route-progress" />
        </MantineProvider>
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
            {
              name: 'React Query',
              render: <ReactQueryDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
