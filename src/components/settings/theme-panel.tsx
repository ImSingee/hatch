import { Badge, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCheck } from '@tabler/icons-react';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useId } from 'react';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { themeQueryOptions } from '~queries/theme';
import { setThemeAppearanceFn } from '~server/theme';
import type { ThemeChoice } from '~server/theme-settings';
import {
  THEME_PRESETS,
  type ThemeAppearance,
  type ThemeDocument,
  type ThemeMode,
  type ThemePresetName,
} from '../../../packages/hatch-design-tokens/src';
import { presetsFor, themeChoiceDocument } from './theme-choices';
import classes from './theme-panel.module.css';

const MODE_LABELS = {
  light: 'appearance.mode.light',
  dark: 'appearance.mode.dark',
  system: 'appearance.mode.system',
} as const satisfies Record<ThemeMode, PlainTranslationKey>;

const PRESET_LABELS = {
  desk: 'appearance.preset.desk',
  'desk-dark': 'appearance.preset.deskDark',
} as const satisfies Record<ThemePresetName, PlainTranslationKey>;

const PICKER_TITLES = {
  light: 'appearance.lightTheme.title',
  dark: 'appearance.darkTheme.title',
} as const satisfies Record<ThemeAppearance, PlainTranslationKey>;

type Change =
  | { mode: ThemeMode }
  | { theme: { appearance: ThemeAppearance; preset: ThemePresetName } };

function useSaveAppearance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: Change) => setThemeAppearanceFn({ data: change }),
    onSuccess: (saved) =>
      queryClient.setQueryData(themeQueryOptions.queryKey, saved),
  });
}

/** Light, dark or the device's appearance, for everyone on the instance. */
export function ThemeModePanel() {
  const { t } = useI18n();
  const { data: theme } = useSuspenseQuery(themeQueryOptions);
  const save = useSaveAppearance();
  const pending =
    save.isPending && 'mode' in save.variables ? save.variables.mode : null;

  return (
    <Group justify="space-between" gap="md">
      <Stack gap={2}>
        <Text fw={700} id="theme-mode-label">
          {t('appearance.mode.title')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('appearance.mode.description')}
        </Text>
      </Stack>
      <SegmentedControl
        aria-labelledby="theme-mode-label"
        value={pending ?? theme.mode}
        disabled={save.isPending}
        data={(['light', 'dark', 'system'] as const).map((mode) => ({
          value: mode,
          label: t(MODE_LABELS[mode]),
        }))}
        onChange={(value) => save.mutate({ mode: value as ThemeMode })}
      />
    </Group>
  );
}

/** A small picture of a theme: its ground, a card and its primary. */
function ThemePreview({ document }: { document: ThemeDocument }) {
  const { colors } = document;
  return (
    <span
      className={classes.preview}
      style={{ backgroundColor: colors.background }}
      aria-hidden
    >
      <span
        className={classes.previewCard}
        style={{ backgroundColor: colors.card, borderColor: colors.border }}
      >
        <span
          className={classes.previewLine}
          style={{ backgroundColor: colors.foreground }}
        />
        <span
          className={classes.previewLineShort}
          style={{ backgroundColor: colors['muted-foreground'] }}
        />
        <span
          className={classes.previewButton}
          style={{ backgroundColor: colors.primary }}
        />
      </span>
    </span>
  );
}

/**
 * The theme one appearance draws: a preset, or the custom theme set through
 * the CLI. Choosing a preset over a custom theme replaces it, after asking.
 */
export function ThemePickerPanel({
  appearance,
}: {
  appearance: ThemeAppearance;
}) {
  const { t } = useI18n();
  const labelId = useId();
  const { data: theme } = useSuspenseQuery(themeQueryOptions);
  const save = useSaveAppearance();
  const choice: ThemeChoice = theme[appearance];
  const pending =
    save.isPending && 'theme' in save.variables
      ? save.variables.theme.preset
      : null;
  const selected = pending ?? choice.preset;

  const choose = (preset: ThemePresetName) => {
    if (preset === choice.preset) return;
    const apply = () => save.mutate({ theme: { appearance, preset } });
    if (choice.preset !== null) return apply();
    modals.openConfirmModal({
      title: t('appearance.customTheme.replaceTitle', { name: choice.name }),
      centered: true,
      children: (
        <Text size="sm">{t('appearance.customTheme.replaceBody')}</Text>
      ),
      labels: {
        confirm: t('appearance.customTheme.replaceConfirm'),
        cancel: t('common.cancel'),
      },
      onConfirm: apply,
    });
  };

  const options = [
    ...presetsFor(appearance).map((preset) => ({
      key: preset,
      preset: preset as ThemePresetName | null,
      document: THEME_PRESETS[preset].document,
      label: t(PRESET_LABELS[preset]),
    })),
    ...(choice.preset === null
      ? [
          {
            key: 'custom',
            preset: null,
            document: themeChoiceDocument(choice),
            label: choice.name,
          },
        ]
      : []),
  ];

  return (
    <Stack gap="sm">
      <Stack gap={2}>
        <Text fw={700} id={labelId}>
          {t(PICKER_TITLES[appearance])}
        </Text>
        <Text size="sm" c="dimmed">
          {t('appearance.theme.description')}
        </Text>
      </Stack>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className={classes.options}
      >
        {options.map((option) => {
          const checked = option.preset === selected;
          return (
            <label key={option.key} className={classes.option}>
              <input
                type="radio"
                name={`theme-${appearance}`}
                className={classes.input}
                value={option.key}
                checked={checked}
                disabled={save.isPending}
                onChange={() => {
                  if (option.preset) choose(option.preset);
                }}
              />
              <ThemePreview document={option.document} />
              <span className={classes.caption}>
                <span className={classes.name}>{option.label}</span>
                {option.preset === null ? (
                  <Badge size="xs" variant="light" color="gray">
                    {t('appearance.customTheme.badge')}
                  </Badge>
                ) : null}
                {checked ? (
                  <IconCheck
                    size={16}
                    stroke={3}
                    className={classes.check}
                    aria-hidden
                  />
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <Text size="xs" c="dimmed">
        {t('appearance.customTheme.hint')}
      </Text>
    </Stack>
  );
}
