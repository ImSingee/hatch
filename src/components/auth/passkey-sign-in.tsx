import { Button, Divider, Stack } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { authErrorOf } from '~auth/auth-errors';
import {
  browserSupportsPasskeys,
  isPasskeyCancellation,
} from '~auth/passkey-browser';
import { i18n, useI18n, useErrorText } from '~i18n';

export function PasskeySignIn({
  appOrigin,
  onSuccess,
  primary = false,
}: {
  appOrigin: string;
  onSuccess: () => Promise<void>;
  /** The passkey is the view's main action, as on the sign-in page. */
  primary?: boolean;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const pending = useRef(false);
  const completing = useRef(false);
  const hasSession = useRef(false);
  const mounted = useRef(true);
  const supported = browserSupportsPasskeys(appOrigin);

  const completeSignIn = useCallback(async () => {
    if (!mounted.current || completing.current) return;
    completing.current = true;
    hasSession.current = true;
    setAuthenticated(true);
    setLoading(true);
    try {
      await onSuccess();
      // The shared instance, so a language switch does not restart autofill.
      toast.success(i18n.t('login.welcomeBack'));
    } catch {
      if (mounted.current) {
        toast.error(i18n.t('auth.passkey.navigationFailed'));
      }
    } finally {
      completing.current = false;
      if (mounted.current) setLoading(pending.current);
    }
  }, [onSuccess]);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    if (supported) {
      void (async () => {
        try {
          const available =
            await PublicKeyCredential.isConditionalMediationAvailable?.();
          if (!available || !active || hasSession.current || pending.current)
            return;

          const result = await authClient.signIn.passkey({ autoFill: true });
          if (active && !result.error && !hasSession.current) {
            await completeSignIn();
          }
        } catch {
          // Autofill is optional; button and password sign-in remain available.
        }
      })();
    }
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [completeSignIn, supported]);

  if (!supported) return null;

  const signIn = async () => {
    if (pending.current || completing.current) return;
    pending.current = true;
    setLoading(true);
    try {
      if (!hasSession.current) {
        const result = await authClient.signIn.passkey();
        if (!mounted.current) return;
        if (result.error) {
          if (!isPasskeyCancellation(result.error)) {
            toast.error(
              errorText(authErrorOf(result.error), 'auth.passkey.signInFailed'),
            );
          }
          return;
        }
        if (hasSession.current) return;
      }

      // Retry only navigation if the SDK already established the session.
      await completeSignIn();
    } catch {
      if (mounted.current) {
        toast.error(t('auth.passkey.signInFailedRetry'));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(completing.current);
    }
  };

  return (
    <Stack gap="md">
      <Button
        type="button"
        variant={primary ? 'filled' : 'default'}
        size="lg"
        fullWidth
        loading={loading}
        leftSection={<IconKey size={18} stroke={1.7} />}
        onClick={signIn}
      >
        {authenticated ? t('common.continue') : t('auth.passkey.signIn')}
      </Button>
      <Divider label={t('auth.passkey.orPassword')} labelPosition="center" />
    </Stack>
  );
}
