import { Alert, Stack, Text } from '@mantine/core';
import { IconCheck, IconInfoCircle } from '@tabler/icons-react';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { themeQueryOptions } from '~queries/theme';
import { setThemeAccentFn } from '~server/theme';
import { activeAppearance, usePrefersDark, type AccentName } from '~ui/theme';
import { themeChoicePrimary } from './theme-choices';
import classes from './accent-panel.module.css';

/** Display name of each accent; the stored value stays the token name. */
const ACCENT_LABELS = {
  indigo: 'appearance.accent.indigo',
  teal: 'appearance.accent.teal',
  clay: 'appearance.accent.clay',
  violet: 'appearance.accent.violet',
} as const satisfies Record<AccentName, PlainTranslationKey>;

/** The radio value of "no accent": each theme shows its own primary. */
const THEME_COLOUR = 'theme';

/** Choose the instance accent; the theme follows once it is saved. */
export function AccentPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: theme } = useSuspenseQuery(themeQueryOptions);
  const prefersDark = usePrefersDark();
  const save = useMutation({
    mutationFn: (accent: AccentName | null) =>
      setThemeAccentFn({ data: accent }),
    onSuccess: (saved) =>
      queryClient.setQueryData(themeQueryOptions.queryKey, saved),
  });
  const selected = save.isPending ? save.variables : theme.accent;
  const ownPrimary = themeChoicePrimary(
    theme[activeAppearance(theme.mode, prefersDark)],
  );
  // A custom theme whose own primary the chosen accent hides.
  const overridden = theme.accentOverrides
    .map((appearance) => theme[appearance])
    .filter((choice) => choice.preset === null);
  const options = [
    ...theme.accents.map((accent) => ({
      value: accent.name as string,
      accent: accent.name as AccentName | null,
      color: accent.color,
      label: t(ACCENT_LABELS[accent.name]),
    })),
    {
      value: THEME_COLOUR,
      accent: null,
      color: ownPrimary,
      label: t('appearance.accent.theme'),
    },
  ];

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
        {overridden.map((choice) => (
          <Alert
            key={choice.appearance}
            variant="light"
            color="gray"
            icon={<IconInfoCircle size={18} aria-hidden />}
          >
            {t('appearance.accent.overrides', { name: choice.name })}
          </Alert>
        ))}
        <div
          role="radiogroup"
          aria-labelledby="accent-label"
          className={classes.swatches}
        >
          {options.map((option) => (
            <label key={option.value} className={classes.swatch}>
              <input
                type="radio"
                name="accent"
                className={classes.input}
                value={option.value}
                checked={option.accent === selected}
                disabled={save.isPending}
                onChange={() => save.mutate(option.accent)}
              />
              <span
                className={classes.dot}
                style={{ backgroundColor: option.color }}
              >
                {option.accent === selected ? (
                  <IconCheck size={18} stroke={3} aria-hidden />
                ) : null}
              </span>
              <span className={classes.name}>{option.label}</span>
            </label>
          ))}
        </div>
      </Stack>
    </div>
  );
}
