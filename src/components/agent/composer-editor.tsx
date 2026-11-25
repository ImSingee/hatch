import { Group, Paper, Text, UnstyledButton } from '@mantine/core';
import { shift } from '@floating-ui/dom';
import { Mention } from '@tiptap/extension-mention';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Slice } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { PluginKey } from '@tiptap/pm/state';
import { EditorContent, ReactRenderer, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  MAX_COMPOSER_REFERENCE_PARTS,
  composerModelText,
  hasComposerReference,
  parseComposerText,
  type ComposerInputPart,
} from '~agent/composer-content';
import { AppGlyph } from '~components/apps/app-glyph';
import { useEventCallback } from '~hooks/use-latest-committed';
import { useI18n } from '~i18n';
import type { AppListItem } from '~server/apps';
import {
  composerDocumentFromParts,
  plainTextComposerDocument,
  serializeComposerDocument,
} from './composer-editor-content';
import classes from './chat.module.css';

type MentionAttributes = {
  id: string;
  label: string;
  slug?: string | null;
};

const resourceMentionSuggestionKey = new PluginKey('resourceMentionSuggestion');

const ResourceMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      slug: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-slug'),
        renderHTML: (attributes) =>
          attributes.slug ? { 'data-slug': attributes.slug } : {},
      },
    };
  },
});

type MentionSource = {
  items: AppListItem[];
  loading: boolean;
  error: boolean;
};

type MentionItem = AppListItem;

type ResourceMentionMenuProps = SuggestionProps<
  MentionItem,
  MentionAttributes
> & {
  source: MentionSource;
  listboxId: string;
  onActiveOptionChange: (optionId: string | undefined) => void;
  onNavigableItemsChange: (hasItems: boolean) => void;
};

type ResourceMentionMenuHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

function mentionOptionId(listboxId: string, item: MentionItem): string {
  return `${listboxId}-option-app-${item.id.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Every App for an empty query; otherwise those whose name or slug match. */
function mentionItems(source: MentionSource, query: string): MentionItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return source.items;
  return source.items.filter((app) =>
    [app.name, app.slug].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    ),
  );
}

/* eslint-disable jsx-a11y/prefer-tag-over-role -- ARIA listbox semantics are
   required for this custom cursor-anchored popup; native select/option cannot
   keep focus and selection inside the rich-text editor. */
const ResourceMentionMenu = forwardRef<
  ResourceMentionMenuHandle,
  ResourceMentionMenuProps
>(function ResourceMentionMenu(
  {
    items,
    command,
    query,
    source,
    listboxId,
    onActiveOptionChange,
    onNavigableItemsChange,
  },
  reference,
) {
  const { t } = useI18n();
  const hasQuery = query.trim().length > 0;
  const navigationLength = items.length;
  const selectionKey = JSON.stringify([query, items.map((item) => item.id)]);
  const [selection, setSelection] = useState({
    key: selectionKey,
    index: 0,
  });
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  let currentSelection = selection;
  if (selection.key !== selectionKey) {
    currentSelection = { key: selectionKey, index: 0 };
    setSelection(currentSelection);
  }
  const activeIndex =
    navigationLength > 0
      ? Math.min(currentSelection.index, navigationLength - 1)
      : -1;
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const activeOptionId = activeItem
    ? mentionOptionId(listboxId, activeItem)
    : undefined;

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  useEffect(() => {
    onActiveOptionChange(activeOptionId);
  }, [activeOptionId, onActiveOptionChange]);
  useEffect(() => {
    onNavigableItemsChange(navigationLength > 0);
  }, [navigationLength, onNavigableItemsChange]);

  const select = (index: number) => {
    const item = items[index];
    if (!item) return;
    command({
      id: item.id,
      label: item.name,
      slug: item.slug,
    });
  };

  useImperativeHandle(reference, () => ({
    onKeyDown(event) {
      if (event.isComposing || event.keyCode === 229) return false;
      if (navigationLength === 0) return false;
      if (event.key === 'ArrowUp') {
        setSelection({
          key: selectionKey,
          index: (activeIndex + navigationLength - 1) % navigationLength,
        });
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelection({
          key: selectionKey,
          index: (activeIndex + 1) % navigationLength,
        });
        return true;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        select(activeIndex);
        return true;
      }
      return false;
    },
  }));

  const status = source.loading
    ? t('mention.loading')
    : source.error
      ? t('mention.loadFailed')
      : null;
  let emptyMessage: string | null = null;
  if (items.length === 0 && !status) {
    emptyMessage = hasQuery ? t('mention.noMatches') : t('mention.empty');
  }

  return (
    <Paper
      id={listboxId}
      withBorder
      radius="md"
      p={4}
      className={classes.mentionMenu}
      role="listbox"
      aria-label={t('mention.label')}
    >
      {items.length > 0 ? (
        <div className={classes.mentionMenuItems}>
          {items.map((item, index) => (
            <UnstyledButton
              key={item.id}
              id={mentionOptionId(listboxId, item)}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className={classes.mentionMenuItem}
              data-selected={index === activeIndex || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (activeIndex !== index) {
                  setSelection({ key: selectionKey, index });
                }
              }}
              onClick={() => select(index)}
            >
              <Group gap="sm" wrap="nowrap">
                <AppGlyph name={item.name} seed={item.id} size="sm" />
                <div className={classes.mentionMenuIdentity}>
                  <Text size="sm" fw={600} truncate>
                    {item.name}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {`/${item.slug}`}
                  </Text>
                </div>
              </Group>
            </UnstyledButton>
          ))}
        </div>
      ) : null}
      {status ? (
        <div className={classes.mentionMenuStatuses} aria-live="polite">
          <Text size="sm" c="dimmed" px="sm" py={6}>
            {status}
          </Text>
        </div>
      ) : null}
      {emptyMessage ? (
        <Text component="output" size="sm" c="dimmed" px="sm" py="xs">
          {emptyMessage}
        </Text>
      ) : null}
    </Paper>
  );
});
/* eslint-enable jsx-a11y/prefer-tag-over-role */

export type ComposerEditorSnapshot = {
  content: ComposerInputPart[];
  revision: number;
  mentionLookupPending: boolean;
};

export type ComposerEditorHandle = {
  getSnapshot: () => ComposerEditorSnapshot;
  clearIfRevision: (revision: number) => void;
};

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  {
    apps?: AppListItem[];
    appsLoading?: boolean;
    appsError?: boolean;
    disabled: boolean;
    focusOnMount: boolean;
    placeholder: string;
    seedText?: string;
    seedNonce?: number;
    /** Initial content with resource mentions; wins over `seedText`. */
    seedContent?: ComposerInputPart[];
    onChange: (content: ComposerInputPart[]) => void;
    onMentionLookupPendingChange: (pending: boolean) => void;
    /** `switchMode`: sent with ⌘/Ctrl held, to flip the busy delivery mode. */
    onSubmit: (options: { switchMode: boolean }) => void;
    onPasteFiles: (files: File[]) => void;
  }
>(function ComposerEditor(
  {
    apps,
    appsLoading = false,
    appsError = false,
    disabled,
    focusOnMount,
    placeholder,
    seedText,
    seedNonce,
    seedContent,
    onChange,
    onMentionLookupPendingChange,
    onSubmit,
    onPasteFiles,
  },
  reference,
) {
  const editorId = useId();
  const listboxId = `${editorId}-resource-mentions`;
  const getSource = useEventCallback((): MentionSource => ({
    items: apps ?? [],
    loading: appsLoading,
    error: appsError,
  }));
  const emitChange = useEventCallback(onChange);
  const emitMentionLookupPendingChange = useEventCallback(
    onMentionLookupPendingChange,
  );
  const emitSubmit = useEventCallback(onSubmit);
  const emitPasteFiles = useEventCallback(onPasteFiles);
  const revisionRef = useRef(0);
  const menuOpenRef = useRef(false);
  const menuHasItemsRef = useRef(false);
  const menuRendererRef = useRef<ReactRenderer<
    ResourceMentionMenuHandle,
    ResourceMentionMenuProps
  > | null>(null);
  const suggestionPropsRef = useRef<SuggestionProps<
    MentionItem,
    MentionAttributes
  > | null>(null);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        trailingNode: false,
        underline: false,
      }),
      Placeholder.configure({ placeholder }),
      ResourceMention.configure({
        HTMLAttributes: { class: classes.composerMention },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        renderHTML: ({ node, options }) => [
          'span',
          options.HTMLAttributes,
          `@${node.attrs.label ?? node.attrs.id}`,
        ],
        suggestion: {
          char: '@',
          pluginKey: resourceMentionSuggestionKey,
          allowSpaces: true,
          placement: 'top-start',
          offset: { mainAxis: 8 },
          floatingUi: { middleware: [shift({ padding: 12 })] },
          items: ({ query }) => mentionItems(getSource(), query),
          allow: ({ state, range }) => {
            let mentions = 0;
            state.doc.descendants((node) => {
              if (node.type.name === 'mention') mentions += 1;
            });
            const mentionType = state.schema.nodes.mention;
            return (
              mentions < MAX_COMPOSER_REFERENCE_PARTS &&
              Boolean(
                mentionType &&
                state.doc
                  .resolve(range.from)
                  .parent.type.contentMatch.matchType(mentionType),
              )
            );
          },
          render: () => {
            let unmount: (() => void) | undefined;
            let editorElement: HTMLElement | undefined;
            const onActiveOptionChange = (optionId: string | undefined) => {
              if (!editorElement) return;
              if (optionId) {
                editorElement.setAttribute('aria-activedescendant', optionId);
              } else {
                editorElement.removeAttribute('aria-activedescendant');
              }
            };
            const onNavigableItemsChange = (hasItems: boolean) => {
              menuHasItemsRef.current = hasItems;
            };
            const menuProps = (
              props: SuggestionProps<MentionItem, MentionAttributes>,
            ): ResourceMentionMenuProps => ({
              ...props,
              source: getSource(),
              listboxId,
              onActiveOptionChange,
              onNavigableItemsChange,
            });
            return {
              onStart(props) {
                menuOpenRef.current = true;
                menuHasItemsRef.current = props.items.length > 0;
                emitMentionLookupPendingChange(getSource().loading);
                editorElement = props.editor.view.dom;
                editorElement.setAttribute('aria-expanded', 'true');
                editorElement.setAttribute('aria-controls', listboxId);
                editorElement.removeAttribute('aria-activedescendant');
                suggestionPropsRef.current = props;
                const renderer = new ReactRenderer<
                  ResourceMentionMenuHandle,
                  ResourceMentionMenuProps
                >(ResourceMentionMenu, {
                  editor: props.editor,
                  props: menuProps(props),
                  className: classes.mentionMenuPortal,
                });
                menuRendererRef.current = renderer;
                unmount = props.mount(renderer.element);
              },
              onUpdate(props) {
                menuHasItemsRef.current = props.items.length > 0;
                emitMentionLookupPendingChange(getSource().loading);
                suggestionPropsRef.current = props;
                menuRendererRef.current?.updateProps(menuProps(props));
              },
              onKeyDown({ view, event }) {
                if (event.key === 'Tab') {
                  exitSuggestion(view, resourceMentionSuggestionKey);
                  return false;
                }
                return menuRendererRef.current?.ref?.onKeyDown(event) ?? false;
              },
              onExit() {
                menuOpenRef.current = false;
                menuHasItemsRef.current = false;
                emitMentionLookupPendingChange(false);
                editorElement?.setAttribute('aria-expanded', 'false');
                editorElement?.removeAttribute('aria-controls');
                editorElement?.removeAttribute('aria-activedescendant');
                editorElement = undefined;
                suggestionPropsRef.current = null;
                unmount?.();
                menuRendererRef.current?.destroy();
                menuRendererRef.current = null;
                unmount = undefined;
              },
            };
          },
        },
      }),
    ],
    [emitMentionLookupPendingChange, getSource, listboxId, placeholder],
  );

  const editor = useEditor({
    extensions,
    content: seedContent
      ? composerDocumentFromParts(seedContent)
      : plainTextComposerDocument(seedText ?? ''),
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: classes.composerEditorContent,
        role: 'textbox',
        'aria-label': placeholder,
        'aria-multiline': 'true',
        'aria-autocomplete': 'list',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        placeholder,
      },
      handleKeyDown: (_view, event) => {
        if (
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.isComposing &&
          event.keyCode !== 229
        ) {
          if (menuOpenRef.current && menuHasItemsRef.current) return false;
          event.preventDefault();
          emitSubmit({ switchMode: event.metaKey || event.ctrlKey });
          return true;
        }
        return false;
      },
      clipboardTextSerializer: (slice) =>
        composerModelText(
          serializeComposerDocument({
            type: 'doc',
            content: slice.content.toJSON(),
          }),
        ),
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length > 0) {
          event.preventDefault();
          emitPasteFiles(files);
          return true;
        }
        const text = (event.clipboardData?.getData('text/plain') ?? '').replace(
          /\r\n?/g,
          '\n',
        );
        const parts = parseComposerText(text);
        if (!hasComposerReference(parts)) return false;
        const makeTransaction = (
          document: ReturnType<typeof composerDocumentFromParts>,
        ) =>
          view.state.tr.replaceSelection(
            Slice.maxOpen(view.state.schema.nodeFromJSON(document).content),
          );
        let transaction = makeTransaction(composerDocumentFromParts(parts));
        let references = 0;
        transaction.doc.descendants((node) => {
          if (node.type.name === 'mention') references += 1;
        });
        if (references > MAX_COMPOSER_REFERENCE_PARTS) {
          transaction = makeTransaction(plainTextComposerDocument(text));
        }
        view.dispatch(
          closeHistory(transaction)
            .setMeta('paste', true)
            .setMeta('uiEvent', 'paste')
            .scrollIntoView(),
        );
        return true;
      },
    },
    onBlur: ({ editor: blurredEditor }) => {
      if (menuOpenRef.current) {
        exitSuggestion(blurredEditor.view, resourceMentionSuggestionKey);
      }
    },
    onUpdate: ({ editor: updatedEditor, transaction }) => {
      // Draft revisions track document edits. Tiptap also emits `update` when
      // editability changes, but that synthetic transaction has no doc change.
      if (!transaction.docChanged) return;
      revisionRef.current += 1;
      emitChange(serializeComposerDocument(updatedEditor.getJSON()));
    },
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  // Read at seed time only: a new array with the same content must not
  // replace what the user typed since.
  const seedContentRef = useRef(seedContent);
  seedContentRef.current = seedContent;
  useEffect(() => {
    if (!editor || seedNonce === undefined) return;
    const content = seedContentRef.current;
    editor.commands.setContent(
      content
        ? composerDocumentFromParts(content)
        : plainTextComposerDocument(seedText ?? ''),
    );
    editor.commands.focus('end');
  }, [editor, seedNonce, seedText]);

  useEffect(() => {
    if (focusOnMount) editor?.commands.focus('end');
  }, [editor, focusOnMount]);

  useEffect(() => {
    const props = suggestionPropsRef.current;
    if (!props || !menuRendererRef.current) return;
    const source = getSource();
    emitMentionLookupPendingChange(source.loading);
    const items = mentionItems(source, props.query);
    menuHasItemsRef.current = items.length > 0;
    const nextProps = {
      ...props,
      items,
    };
    suggestionPropsRef.current = nextProps;
    menuRendererRef.current.updateProps({
      ...nextProps,
      source,
      listboxId,
      onActiveOptionChange: (optionId: string | undefined) => {
        const editorElement = props.editor.view.dom;
        if (optionId) {
          editorElement.setAttribute('aria-activedescendant', optionId);
        } else {
          editorElement.removeAttribute('aria-activedescendant');
        }
      },
      onNavigableItemsChange: (hasItems: boolean) => {
        menuHasItemsRef.current = hasItems;
      },
    });
  }, [
    apps,
    appsError,
    appsLoading,
    emitMentionLookupPendingChange,
    getSource,
    listboxId,
  ]);

  useImperativeHandle(
    reference,
    () => ({
      getSnapshot: () => ({
        content: editor ? serializeComposerDocument(editor.getJSON()) : [],
        revision: revisionRef.current,
        mentionLookupPending: menuOpenRef.current && getSource().loading,
      }),
      clearIfRevision: (revision) => {
        if (revisionRef.current === revision) editor?.commands.clearContent();
      },
    }),
    [editor, getSource],
  );

  return <EditorContent editor={editor} className={classes.composerEditor} />;
});
