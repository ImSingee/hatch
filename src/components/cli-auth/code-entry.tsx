import { Alert, Anchor, Button, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useI18n, type PlainTranslationKey } from '~i18n';
import {
  formatUserCode,
  normalizeUserCode,
  USER_CODE_LENGTH,
} from './device-api';
import { ViewHeader } from './layout';
import { retryWait, type EntryProblem } from './problems';
import classes from './device-approval.module.css';

const PROBLEM_TEXT: Record<
  Exclude<EntryProblem, 'invalid' | 'rate-limited'>,
  PlainTranslationKey
> = {
  network: 'cliAuth.entry.network',
  server: 'cliAuth.entry.server',
};

type CodeEntryProps = {
  code: string;
  onCodeChange: (code: string) => void;
  onSubmit: () => void;
  pending: boolean;
  problem: EntryProblem | null;
  /** Server-reported wait for a rate-limited review, in seconds. */
  retryAfter: number | null;
  account: string | null;
  onSwitchAccount: () => void;
  /** Move focus to the field: no code was supplied, or the person started over. */
  focus: boolean;
};

export function CodeEntry({
  code,
  onCodeChange,
  onSubmit,
  pending,
  problem,
  retryAfter,
  account,
  onSwitchAccount,
  focus,
}: CodeEntryProps) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [incomplete, setIncomplete] = useState(false);

  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);

  const fieldError = incomplete
    ? t('cliAuth.entry.incomplete', { length: USER_CODE_LENGTH })
    : problem === 'invalid'
      ? t('cliAuth.entry.invalid')
      : undefined;

  return (
    <>
      <ViewHeader title={t('cliAuth.entry.title')}>
        {t('cliAuth.entry.description')}
      </ViewHeader>

      <form
        className={classes.sheet}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          if (code.length !== USER_CODE_LENGTH) {
            setIncomplete(true);
            input.current?.focus();
            return;
          }
          onSubmit();
        }}
      >
        <TextInput
          ref={input}
          label={t('cliAuth.entry.codeLabel')}
          placeholder="XXXX-XXXX"
          value={formatUserCode(code)}
          onChange={(event) => {
            setIncomplete(false);
            onCodeChange(normalizeUserCode(event.currentTarget.value));
          }}
          readOnly={pending}
          error={fieldError}
          size="lg"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          classNames={{ input: classes.codeInput, label: classes.codeLabel }}
        />
        {problem && problem !== 'invalid' ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={18} stroke={1.75} />}
            role="alert"
          >
            {problem === 'rate-limited'
              ? t('cliAuth.entry.rateLimited', {
                  wait: retryWait(t, retryAfter),
                })
              : t(PROBLEM_TEXT[problem])}
          </Alert>
        ) : null}
        <Button type="submit" size="md" fullWidth loading={pending}>
          {t('common.continue')}
        </Button>
      </form>

      <Text size="sm" c="dimmed" ta="center" className={classes.footnote}>
        {account ? (
          <>
            <Trans
              t={t}
              i18nKey="cliAuth.entry.signedInAs"
              values={{ account }}
              components={{
                account: (
                  <Text span size="sm" fw={600} c="var(--mantine-color-text)" />
                ),
              }}
            />{' '}
          </>
        ) : null}
        <Anchor
          component="button"
          type="button"
          size="sm"
          onClick={onSwitchAccount}
        >
          {t('cliAuth.useDifferentAccount')}
        </Anchor>
      </Text>
    </>
  );
}
