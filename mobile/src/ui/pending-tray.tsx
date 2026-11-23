/** Messages sent while the Agent works, waiting above the composer. */
import { useRef, useState } from 'react';
import { View } from 'react-native';
import type { PendingMessage, PendingMessages } from '../core';
import { Button, IconButton } from './button';
import { useAccent } from './accent';
import { Glyph } from './glyph';
import { NativeField, type NativeFieldRef } from './native-field';
import { Text, type } from './text';
import { palette as c, radii, weights } from './theme';

const MODE_LABEL = { queue: 'Queued', steer: 'Steer' } as const;

/** The app edits plain text only; mentions and files are edited on the web. */
function plainText(message: PendingMessage): boolean {
  return message.content.every(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      part.type === 'text',
  );
}

function PendingRow({
  message,
  busy,
  onSave,
  onCancel,
  onSendNow,
}: {
  message: PendingMessage;
  busy: boolean;
  onSave: (text: string) => Promise<boolean>;
  onCancel: () => void;
  onSendNow: () => void;
}) {
  const accent = useAccent();
  const [draft, setDraft] = useState<string | null>(null);
  // Native text can change before its event reaches JavaScript; Save reads
  // the field itself.
  const field = useRef<NativeFieldRef>(null);
  const editable = message.status === 'pending';
  // A run taking the message in ends any edit: it can no longer change.
  const [wasEditable, setWasEditable] = useState(editable);
  if (wasEditable !== editable) {
    setWasEditable(editable);
    if (!editable) setDraft(null);
  }
  const editing = editable && draft !== null;
  const files = message.images.length + message.attachments.length;
  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderRadius: radii.lg,
        backgroundColor: c.card,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text
          style={[
            type.meta,
            {
              color: message.mode === 'steer' ? accent.ink : c.inkSoft,
              fontWeight: weights.label,
            },
          ]}
        >
          {MODE_LABEL[message.mode]}
        </Text>
        {!editing ? (
          <Text style={[type.callout, { flex: 1 }]} numberOfLines={2}>
            {message.text || (files ? 'Attachments only' : '')}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {!editable ? (
          <Text style={type.meta}>Sending…</Text>
        ) : !editing ? (
          <View style={{ flexDirection: 'row' }}>
            {plainText(message) ? (
              <IconButton
                label="Edit message"
                glyph="edit"
                tone="clear"
                size={36}
                disabled={busy}
                onPress={() => setDraft(message.text)}
              />
            ) : null}
            <IconButton
              label="Send now"
              glyph="send"
              tone="clear"
              size={36}
              disabled={busy}
              onPress={onSendNow}
            />
            <IconButton
              label="Cancel message"
              glyph="close"
              tone="clear"
              size={36}
              disabled={busy}
              onPress={onCancel}
            />
          </View>
        ) : null}
      </View>
      {files && !editing ? (
        <Text style={type.meta}>
          {files === 1 ? '1 attachment' : `${files} attachments`}
        </Text>
      ) : null}
      {editable && draft !== null ? (
        <View style={{ gap: 8 }}>
          <NativeField
            ref={field}
            label="Edit message"
            value={draft}
            onChange={setDraft}
            placeholder="Edit message…"
            multiline
            maxLength={50000}
            unavailable={busy}
          />
          <View
            style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}
          >
            <Button
              label="Discard changes"
              variant="quiet"
              size="small"
              onPress={() => setDraft(null)}
            />
            <Button
              label="Save"
              size="small"
              busy={busy}
              disabled={!draft.trim() && files === 0}
              onPress={() => {
                if (!editable) return;
                void onSave(field.current?.getText() ?? draft).then((saved) => {
                  if (saved) setDraft(null);
                });
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function PendingTray({
  pending,
  busy,
  onSave,
  onCancel,
  onSendNow,
  onResume,
}: {
  pending: PendingMessages;
  busy: boolean;
  onSave: (id: string, text: string) => Promise<boolean>;
  onCancel: (id: string) => void;
  onSendNow: (id: string) => void;
  onResume: () => void;
}) {
  if (!pending.messages.length) return null;
  return (
    <View
      accessibilityLabel="Pending messages"
      style={{
        gap: 6,
        padding: 6,
        borderRadius: radii.xl,
        backgroundColor: c.sunken,
      }}
    >
      {pending.paused ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 6,
          }}
        >
          <Glyph name="pause" size={12} color={c.inkSoft} />
          <Text style={[type.small, { flex: 1 }]}>
            Paused after the last reply stopped.
          </Text>
          <Button
            label="Resume"
            variant="secondary"
            size="small"
            disabled={busy}
            onPress={onResume}
          />
        </View>
      ) : null}
      {pending.messages.map((message) => (
        <PendingRow
          key={message.id}
          message={message}
          busy={busy}
          onSave={(text) => onSave(message.id, text)}
          onCancel={() => onCancel(message.id)}
          onSendNow={() => onSendNow(message.id)}
        />
      ))}
    </View>
  );
}
