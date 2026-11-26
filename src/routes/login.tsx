import {
  Button,
  PasswordInput,
  SegmentedControl,
  Stack,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { announceSignIn, authClient } from '~auth/client';
import { authErrorOf } from '~auth/auth-errors';
import { browserSupportsPasskeys } from '~auth/passkey-browser';
import { Brand } from '~components/desk/brand';
import { DeskStandalone } from '~components/desk/desk-standalone';
import { PasskeySignIn } from '~components/auth/passkey-sign-in';
import {
  StandaloneWindow,
  WindowHero,
} from '~components/page/standalone-window';
import { hasActiveSession } from '~server/auth';
import { getSignupConfig } from '~server/users';
import { translateError, useI18n, type PlainTranslationKey } from '~i18n';
import { passkeyOriginQueryOptions } from '~queries/passkeys';
import classes from './login.module.css';

/**
 * Resolve the post-login destination. Only same-origin absolute paths are
 * honored so a crafted `?redirect=` can't bounce a freshly authenticated user
 * to another origin (`//evil.com`, `https://evil.com`, `/\evil.com`).
 */
function safeRedirect(target: string | undefined): string {
  if (target && /^\/(?![/\\])/.test(target)) return target;
  return '/';
}

export const Route = createFileRoute('/login')({
  validateSearch: (search): { redirect?: string } => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const authenticated = await hasActiveSession();
    if (authenticated) {
      throw redirect({ href: safeRedirect(search.redirect) });
    }
  },
  // Whether to offer "Create account" is a runtime platform setting — the
  // server enforces it either way; this only keeps the UI honest.
  loader: async ({ context: { queryClient } }) => {
    const [signup, appOrigin] = await Promise.all([
      getSignupConfig(),
      queryClient.ensureQueryData(passkeyOriginQueryOptions),
    ]);
    return { ...signup, appOrigin };
  },
  component: LoginPage,
});

type Mode = 'signin' | 'signup';

function LoginPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { redirect: redirectTo } = Route.useSearch();
  const { allowSignup, appOrigin } = Route.useLoaderData();
  const [rawMode, setRawMode] = useState<Mode>('signin');
  // When sign-up is closed there is nothing to switch to — pin sign-in even if
  // a signup mode was selected before the config loaded.
  const mode: Mode = allowSignup ? rawMode : 'signin';
  const [passwordLoading, setPasswordLoading] = useState(false);
  // With a passkey offered it is the primary action; the password form is
  // the alternative.
  const passkeysAvailable = browserSupportsPasskeys(appOrigin);

  const navigateAfterAuthentication = useCallback(async () => {
    // A session that expired in this document may have left another user's
    // pins and dashboards in the cache; the new user must never see them.
    queryClient.removeQueries();
    announceSignIn();
    await router.navigate({ href: safeRedirect(redirectTo) });
  }, [queryClient, redirectTo, router]);

  // Validation stores catalog keys; the fields translate them at render.
  const form = useForm({
    initialValues: { name: '', email: '', password: '' },
    validate: {
      email: (v) =>
        /^\S+@\S+\.\S+$/.test(v)
          ? null
          : ('login.validation.email' satisfies PlainTranslationKey),
      password: (v) =>
        v.length >= 8
          ? null
          : ('login.validation.password' satisfies PlainTranslationKey),
      name: (v) =>
        mode === 'signup' && v.trim().length === 0
          ? ('login.validation.name' satisfies PlainTranslationKey)
          : null,
    },
  });
  const fieldProps = (field: 'name' | 'email' | 'password') => {
    const props = form.getInputProps(field);
    const error = form.errors[field];
    return {
      ...props,
      error:
        typeof error === 'string' ? t(error as PlainTranslationKey) : error,
    };
  };

  const submit = form.onSubmit(async (values) => {
    setPasswordLoading(true);
    try {
      const result =
        mode === 'signin'
          ? await authClient.signIn.email({
              email: values.email,
              password: values.password,
            })
          : await authClient.signUp.email({
              email: values.email,
              password: values.password,
              name: values.name.trim(),
            });

      if (result.error) {
        toast.error(
          translateError(
            t,
            locale,
            authErrorOf(result.error),
            'login.error.failed',
          ),
        );
        return;
      }
      toast.success(
        mode === 'signin' ? t('login.welcomeBack') : t('login.accountCreated'),
      );
      await navigateAfterAuthentication();
    } catch {
      toast.error(t('login.error.unexpected'));
    } finally {
      setPasswordLoading(false);
    }
  });

  return (
    <DeskStandalone>
      <StandaloneWindow
        title={mode === 'signin' ? t('login.signIn') : t('login.createAccount')}
        footer={
          !allowSignup
            ? t('login.footer.signupClosed')
            : mode === 'signin'
              ? t('login.footer.newHere')
              : t('login.footer.haveAccount')
        }
      >
        <WindowHero
          tile={<Brand size="lg" withWordmark={false} />}
          title={
            mode === 'signin'
              ? t('login.welcomeBack')
              : t('login.createYourAccount')
          }
        >
          {t('login.tagline')}
        </WindowHero>
        {allowSignup && (
          <SegmentedControl
            fullWidth
            value={mode}
            onChange={(v) => setRawMode(v as Mode)}
            data={[
              { label: t('login.signIn'), value: 'signin' },
              { label: t('login.createAccount'), value: 'signup' },
            ]}
          />
        )}
        {mode === 'signin' ? (
          <PasskeySignIn
            primary
            appOrigin={appOrigin}
            onSuccess={navigateAfterAuthentication}
          />
        ) : null}
        <form onSubmit={submit} className={classes.form}>
          <Stack gap="md">
            {mode === 'signup' ? (
              <TextInput
                size="md"
                label={t('login.name')}
                {...fieldProps('name')}
              />
            ) : null}
            <TextInput
              size="md"
              label={t('login.email')}
              autoComplete={
                mode === 'signin'
                  ? browserSupportsPasskeys(appOrigin)
                    ? 'username webauthn'
                    : 'username'
                  : 'email'
              }
              {...fieldProps('email')}
            />
            <PasswordInput
              visibilityToggleButtonProps={{
                'aria-label': t('system.togglePasswordVisibility'),
              }}
              size="md"
              label={t('login.password')}
              {...fieldProps('password')}
            />
            <Button
              type="submit"
              loading={passwordLoading}
              mt="xs"
              fullWidth
              size="lg"
              variant={
                mode === 'signin' && passkeysAvailable ? 'default' : 'filled'
              }
            >
              {mode === 'signin' ? t('login.signIn') : t('login.createAccount')}
            </Button>
          </Stack>
        </form>
      </StandaloneWindow>
    </DeskStandalone>
  );
}
