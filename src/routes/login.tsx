import {
  Button,
  PasswordInput,
  SegmentedControl,
  Stack,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
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
  const router = useRouter();
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
    await router.navigate({ href: safeRedirect(redirectTo) });
  }, [redirectTo, router]);

  const form = useForm({
    initialValues: { name: '', email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : 'Enter a valid email'),
      password: (v) =>
        v.length >= 8 ? null : 'Password must be at least 8 characters',
      name: (v) =>
        mode === 'signup' && v.trim().length === 0 ? 'Enter your name' : null,
    },
  });

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
        toast.error(result.error.message ?? 'Authentication failed');
        return;
      }
      toast.success(mode === 'signin' ? 'Welcome back' : 'Account created');
      await navigateAfterAuthentication();
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setPasswordLoading(false);
    }
  });

  return (
    <DeskStandalone>
      <StandaloneWindow
        title={mode === 'signin' ? 'Sign in' : 'Create account'}
        footer={
          !allowSignup
            ? 'Sign-up is closed. Ask the owner of this space for access.'
            : mode === 'signin'
              ? 'New here? Switch to Create account above.'
              : 'Already have an account? Switch to Sign in above.'
        }
      >
        <WindowHero
          tile={<Brand size="lg" withWordmark={false} />}
          title={mode === 'signin' ? 'Welcome back' : 'Create your account'}
        >
          Spin up your own apps just by talking to AI.
        </WindowHero>
        {allowSignup && (
          <SegmentedControl
            fullWidth
            value={mode}
            onChange={(v) => setRawMode(v as Mode)}
            data={[
              { label: 'Sign in', value: 'signin' },
              { label: 'Create account', value: 'signup' },
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
                label="Name"
                {...form.getInputProps('name')}
              />
            ) : null}
            <TextInput
              size="md"
              label="Email"
              autoComplete={
                mode === 'signin'
                  ? browserSupportsPasskeys(appOrigin)
                    ? 'username webauthn'
                    : 'username'
                  : 'email'
              }
              {...form.getInputProps('email')}
            />
            <PasswordInput
              size="md"
              label="Password"
              {...form.getInputProps('password')}
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
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </Stack>
        </form>
      </StandaloneWindow>
    </DeskStandalone>
  );
}
