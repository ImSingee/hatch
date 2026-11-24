import { Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { themeQueryOptions } from '~queries/theme';
import { setThemeAccentFn } from '~server/theme';
import { applyAccent, type AccentName } from '~ui/theme';
import classes from './accent-panel.module.css';

/** Display name of each accent; the stored value stays the token name. */
const ACCENT_LABELS = {
  indigo: 'appearance.accent.indigo',
  teal: 'appearance.accent.teal',
  clay: 'appearance.accent.clay',
  violet: 'appearance.accent.violet',
} as const satisfies Record<AccentName, PlainTranslationKey>;

/** Choose the instance accent; the change shows at once and is then saved. */
export function AccentPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: theme } = useSuspenseQuery(themeQueryOptions);
  const save = useMutation({
    mutationFn: (accent: AccentName) => setThemeAccentFn({ data: accent }),
    onMutate: (accent) => {
      const previous = theme.accent;
      applyAccent(accent);
      return { previous };
    },
    onSuccess: (saved) =>
      queryClient.setQueryData(themeQueryOptions.queryKey, saved),
    onError: (_error, _accent, context) => {
      if (context) applyAccent(context.previous);
    },
  });
  const selected = save.isPending ? save.variables : theme.accent;

  return (
    <div>
      <Stack gap="sm">
        <Stack gap={2}>
          <Text fw={700} id="accent-label">
            {t('appearance.accent.title')}
          </Text>
          <Text size="sm" c="dimmed">
            {t('appearance.accent.description')}
          </Text>
        </Stack>
        <div
          role="radiogroup"
          aria-labelledby="accent-label"
          className={classes.swatches}
        >
          {theme.accents.map((accent) => (
            <label key={accent.name} className={classes.swatch}>
              <input
                type="radio"
                name="accent"
                className={classes.input}
                value={accent.name}
                checked={accent.name === selected}
                onChange={() => save.mutate(accent.name)}
              />
              <span
                className={classes.dot}
                style={{ backgroundColor: accent.color }}
              >
                {accent.name === selected ? (
                  <IconCheck size={18} stroke={3} aria-hidden />
                ) : null}
              </span>
              <span className={classes.name}>
                {t(ACCENT_LABELS[accent.name])}
              </span>
            </label>
          ))}
        </div>
      </Stack>
    </div>
  );
}
