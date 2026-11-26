import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  ColorInput,
  Group,
  Menu,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  IconCheck,
  IconCopy,
  IconDots,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useId, useState } from 'react';
import { type PlainTranslationKey, useErrorText, useI18n } from '~i18n';
import { themeQueryOptions, themesQueryOptions } from '~queries/theme';
import {
  activateThemeFn,
  deleteThemeFn,
  saveThemeFn,
  type SaveThemeResult,
} from '~server/theme';
import type { ThemeEntry } from '~server/theme-settings';
import {
  BUNDLED_FONTS,
  MAX_RADIUS,
  THEME_COLOR_KEYS,
  THEME_PRESETS,
  type ThemeColorKey,
  type ThemeDocument,
  type ThemeProblem,
} from '../../../packages/hatch-design-tokens/src';
import classes from './theme-panel.module.css';

/** The preset whose colours a theme switched to this appearance starts from. */
const PRESET_FOR = { light: 'desk', dark: 'desk-dark' } as const;

/** Label of each document colour, and of each role a contrast pair names. */
const ROLE_LABELS: Record<string, PlainTranslationKey> = {
  background: 'appearance.themeEditor.color.background',
  foreground: 'appearance.themeEditor.color.foreground',
  card: 'appearance.themeEditor.color.card',
  primary: 'appearance.themeEditor.color.primary',
  secondary: 'appearance.themeEditor.color.secondary',
  muted: 'appearance.themeEditor.color.muted',
  'muted-foreground': 'appearance.themeEditor.color.mutedForeground',
  border: 'appearance.themeEditor.color.border',
  destructive: 'appearance.themeEditor.color.destructive',
  'primary-foreground': 'appearance.themeEditor.role.primaryForeground',
  'primary-text': 'appearance.themeEditor.role.primaryText',
  'destructive-foreground': 'appearance.themeEditor.role.destructiveForeground',
  'destructive-text': 'appearance.themeEditor.role.destructiveText',
  'primary-ink': 'appearance.themeEditor.role.primaryInk',
  'primary-tint': 'appearance.themeEditor.role.primaryTint',
  'primary-tint-strong': 'appearance.themeEditor.role.primaryTintStrong',
  'destructive-ink': 'appearance.themeEditor.role.destructiveInk',
  'destructive-tint': 'appearance.themeEditor.role.destructiveTint',
  'destructive-tint-strong':
    'appearance.themeEditor.role.destructiveTintStrong',
};

/** A small picture of a theme: its ground, a card and its primary. */
function ThemePreview({ document }: { document: ThemeDocument }) {
  const colors = document.colors ?? ({} as ThemeDocument['colors']);
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

function useInvalidateTheme() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: themeQueryOptions.queryKey });
}

/**
 * The theme library: presets and custom themes as cards. Choosing a card
 * makes it the theme every client draws; custom themes can be edited and
 * deleted, and any theme copied into a new custom one.
 */
export function ThemeLibraryPanel() {
  const { t } = useI18n();
  const labelId = useId();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateTheme();
  const { data: state } = useSuspenseQuery(themeQueryOptions);
  const { data: themes } = useSuspenseQuery(themesQueryOptions);
  const [editing, setEditing] = useState<{
    id?: string;
    document: ThemeDocument;
  } | null>(null);
  const activate = useMutation({
    mutationFn: (id: string) => activateThemeFn({ data: id }),
    onSuccess: (saved) =>
      queryClient.setQueryData(themeQueryOptions.queryKey, saved),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteThemeFn({ data: id }),
    onSuccess: () => invalidate(),
  });
  const activeId = activate.isPending ? activate.variables : state.theme.id;

  // Names are unique (ignoring case), so a copy takes the first free one.
  const copyOf = (theme: ThemeEntry): ThemeDocument => {
    const taken = new Set(themes.map((entry) => entry.name.toLowerCase()));
    let name: string = t('appearance.themes.copyName', { name: theme.name });
    for (let number = 2; taken.has(name.toLowerCase()); number++)
      name = t('appearance.themes.copyNameNumbered', {
        name: theme.name,
        number,
      });
    return { ...theme.document, name };
  };
  const confirmDelete = (theme: ThemeEntry) =>
    modals.openConfirmModal({
      title: t('appearance.themes.deleteTitle', { name: theme.name }),
      centered: true,
      children: <Text size="sm">{t('appearance.themes.deleteBody')}</Text>,
      labels: {
        confirm: t('appearance.themes.delete'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(theme.id),
    });

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start" gap="md">
        <Stack gap={2} style={{ flex: '1 1 240px' }}>
          <Text fw={700} id={labelId}>
            {t('appearance.themes.title')}
          </Text>
          <Text size="sm" c="dimmed">
            {t('appearance.themes.description')}
          </Text>
        </Stack>
        <Button
          variant="default"
          leftSection={<IconPlus size={16} aria-hidden />}
          onClick={() => setEditing({ document: copyOf(state.theme) })}
        >
          {t('appearance.themes.new')}
        </Button>
      </Group>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className={classes.options}
      >
        {themes.map((theme) => {
          const checked = theme.id === activeId;
          const isActive = theme.id === state.theme.id;
          return (
            <div key={theme.id} className={classes.option}>
              <label className={classes.optionLabel}>
                <input
                  type="radio"
                  name="theme"
                  className={classes.input}
                  value={theme.id}
                  checked={checked}
                  disabled={activate.isPending || !theme.valid}
                  onChange={() => activate.mutate(theme.id)}
                />
                <ThemePreview document={theme.document} />
                <span className={classes.caption}>
                  <span className={classes.name}>{theme.name}</span>
                  {checked ? (
                    <IconCheck
                      size={16}
                      stroke={3}
                      className={classes.check}
                      aria-hidden
                    />
                  ) : null}
                </span>
                <span className={classes.badges}>
                  <Badge size="xs" variant="light" color="gray">
                    {t(
                      theme.appearance === 'dark'
                        ? 'appearance.themes.dark'
                        : 'appearance.themes.light',
                    )}
                  </Badge>
                  {theme.source === 'custom' ? (
                    <Badge size="xs" variant="light" color="gray">
                      {t('appearance.themes.custom')}
                    </Badge>
                  ) : null}
                  {theme.valid ? null : (
                    <Badge size="xs" variant="light" color="red">
                      {t('appearance.themes.invalid')}
                    </Badge>
                  )}
                </span>
              </label>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    className={classes.menu}
                    aria-label={t('appearance.themes.actions', {
                      name: theme.name,
                    })}
                  >
                    <IconDots size={16} aria-hidden />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {theme.source === 'custom' ? (
                    <Menu.Item
                      leftSection={<IconPencil size={16} aria-hidden />}
                      onClick={() =>
                        setEditing({ id: theme.id, document: theme.document })
                      }
                    >
                      {t('appearance.themes.edit')}
                    </Menu.Item>
                  ) : null}
                  <Menu.Item
                    leftSection={<IconCopy size={16} aria-hidden />}
                    onClick={() => setEditing({ document: copyOf(theme) })}
                  >
                    {t('appearance.themes.duplicate')}
                  </Menu.Item>
                  {theme.source === 'custom' ? (
                    <Menu.Item
                      color="red"
                      disabled={isActive}
                      leftSection={<IconTrash size={16} aria-hidden />}
                      onClick={() => confirmDelete(theme)}
                    >
                      {isActive
                        ? t('appearance.themes.deleteActive')
                        : t('appearance.themes.delete')}
                    </Menu.Item>
                  ) : null}
                </Menu.Dropdown>
              </Menu>
            </div>
          );
        })}
      </div>
      {editing ? (
        <ThemeEditor
          id={editing.id}
          initial={editing.document}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void invalidate();
          }}
        />
      ) : null}
    </Stack>
  );
}

function translatedProblem(
  t: ReturnType<typeof useI18n>['t'],
  problem: ThemeProblem,
): string {
  const role = (name: string) =>
    ROLE_LABELS[name] ? t(ROLE_LABELS[name]) : name;
  const field = problem.path.startsWith('colors.')
    ? role(problem.path.slice('colors.'.length))
    : problem.path;
  switch (problem.code) {
    case 'low_contrast':
      return t('appearance.themeEditor.problem.lowContrast', {
        foreground: role(problem.pair?.foreground ?? ''),
        background: role(problem.pair?.background ?? ''),
        ratio: problem.pair?.ratio ?? 0,
      });
    case 'unknown_key':
      return t('appearance.themeEditor.problem.unknownKey', { field });
    case 'missing_key':
      return t('appearance.themeEditor.problem.missingKey', { field });
    case 'invalid_color':
      return t('appearance.themeEditor.problem.invalidColor', { field });
    case 'invalid_value':
      return t('appearance.themeEditor.problem.invalidValue', { field });
    case 'unknown_font':
      return t('appearance.themeEditor.problem.unknownFont', { field });
    case 'invalid_document':
      return t('appearance.themeEditor.problem.invalidDocument');
  }
}

/**
 * Edit a theme document: its name, appearance, nine colours, base radius
 * and fonts. Every other token is derived from these; there is no per-token
 * editor. The platform checks the document on save and the problems show
 * here, translated.
 */
function ThemeEditor({
  id,
  initial,
  onClose,
  onSaved,
}: {
  id?: string;
  initial: ThemeDocument;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [document, setDocument] = useState<ThemeDocument>(initial);
  const [problems, setProblems] = useState<ThemeProblem[]>([]);
  const save = useMutation({
    mutationFn: (): Promise<SaveThemeResult> =>
      saveThemeFn({ data: { id, document } }),
    // Every failure shows in the editor, next to what it is about.
    meta: { errorToast: false },
    onMutate: () => setProblems([]),
    onSuccess: (result) => {
      if (result.ok) onSaved();
      else setProblems(result.problems);
    },
  });
  const nameTaken =
    (save.error as { code?: unknown } | null)?.code === 'theme_name_taken';
  const saveError =
    save.error && !nameTaken ? errorText(save.error, 'error.generic') : null;
  const setColor = (key: ThemeColorKey, value: string) =>
    setDocument((current) => ({
      ...current,
      colors: { ...current.colors, [key]: value },
    }));
  const fieldError = (path: string) =>
    problems.some((problem) => problem.path === path) || undefined;

  return (
    <Modal
      opened
      onClose={onClose}
      size="lg"
      title={
        id
          ? t('appearance.themeEditor.editTitle')
          : t('appearance.themeEditor.newTitle')
      }
    >
      <Stack gap="md">
        <Group align="flex-start" gap="lg" wrap="wrap">
          <Stack gap="sm" style={{ flex: '1 1 260px' }}>
            <TextInput
              label={t('appearance.themeEditor.name')}
              value={document.name ?? ''}
              maxLength={48}
              error={
                nameTaken
                  ? errorText(save.error, 'error.generic')
                  : fieldError('name')
              }
              onChange={(event) => {
                const name = event.currentTarget.value;
                setDocument((current) => ({ ...current, name }));
              }}
            />
            <Stack gap={4}>
              <Text size="sm" fw={700} id="theme-editor-appearance">
                {t('appearance.themeEditor.appearance')}
              </Text>
              <SegmentedControl
                aria-labelledby="theme-editor-appearance"
                value={document.appearance}
                data={[
                  { value: 'light', label: t('appearance.themes.light') },
                  { value: 'dark', label: t('appearance.themes.dark') },
                ]}
                onChange={(value) => {
                  const appearance = value as ThemeDocument['appearance'];
                  // Colours read on one appearance are unreadable on the
                  // other, so the switch starts from that preset's colours.
                  setDocument((current) => ({
                    ...current,
                    appearance,
                    colors: {
                      ...THEME_PRESETS[PRESET_FOR[appearance]].document.colors,
                    },
                  }));
                }}
              />
              <Text size="xs" c="dimmed">
                {t('appearance.themeEditor.appearanceHint')}
              </Text>
            </Stack>
          </Stack>
          <ThemePreview document={document} />
        </Group>
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          {THEME_COLOR_KEYS.map((key) => (
            <ColorInput
              key={key}
              label={t(ROLE_LABELS[key])}
              format="hex"
              value={document.colors[key]}
              error={fieldError(`colors.${key}`)}
              onChange={(value) => setColor(key, value)}
            />
          ))}
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
          <NumberInput
            label={t('appearance.themeEditor.radius')}
            min={0}
            max={MAX_RADIUS}
            suffix=" px"
            value={document.radius}
            error={fieldError('radius')}
            onChange={(value) =>
              setDocument((current) => ({
                ...current,
                radius: typeof value === 'number' ? value : current.radius,
              }))
            }
          />
          {(['sans', 'mono'] as const).map((role) => (
            <Select
              key={role}
              label={t(
                role === 'sans'
                  ? 'appearance.themeEditor.fontSans'
                  : 'appearance.themeEditor.fontMono',
              )}
              allowDeselect={false}
              value={document.fonts[role]}
              error={fieldError(`fonts.${role}`)}
              data={BUNDLED_FONTS[role].map((face) => ({
                value: face,
                label:
                  face === 'system'
                    ? t('appearance.themeEditor.fontSystem')
                    : face,
              }))}
              onChange={(value) =>
                value &&
                setDocument((current) => ({
                  ...current,
                  fonts: { ...current.fonts, [role]: value },
                }))
              }
            />
          ))}
        </SimpleGrid>
        {problems.length ? (
          <Alert
            color="red"
            variant="light"
            title={t('appearance.themeEditor.rejected')}
          >
            <Stack gap={4}>
              {problems.map((problem, index) => (
                // Problems have no ids; their order is stable per answer.
                // oxlint-disable-next-line react/no-array-index-key
                <Text key={index} size="sm">
                  {translatedProblem(t, problem)}
                </Text>
              ))}
            </Stack>
          </Alert>
        ) : null}
        {saveError ? (
          <Alert color="red" variant="light">
            {saveError}
          </Alert>
        ) : null}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            {t('appearance.themeEditor.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
