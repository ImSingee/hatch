import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSession } from '../src/state/session';
import type { AgentMessageMode } from '../src/core';
import { Button } from '../src/ui/button';
import { Choice } from '../src/ui/native-controls';
import { glyphs, type GlyphName } from '../src/ui/glyph.types';
import { Card, Tag, errorText } from '../src/ui/primitives';
import { GlyphTile } from '../src/ui/rows';
import { Masthead, pageScrollProps, readable } from '../src/ui/screen';
import { Text, type } from '../src/ui/text';
import { palette as c } from '../src/ui/theme';

const notes: { glyph: GlyphName; title: string; detail: string }[] = [
  {
    glyph: 'agent',
    title: 'Your Agent works on the server',
    detail:
      'Leave the app whenever you like. Runs keep going on your instance and you can catch up later.',
  },
  {
    glyph: 'browser',
    title: 'Some things stay on the web',
    detail:
      'Providers, secrets, dashboard editing and account management live in Hatch on the web.',
  },
  {
    glyph: 'server',
    title: 'Kept in this phone’s keychain',
    detail:
      'Your session is stored securely on this device. Hatch accounts have full access to their instance.',
  },
];

const MESSAGE_MODES: {
  value: AgentMessageMode;
  label: string;
  detail: string;
}[] = [
  {
    value: 'steer',
    label: 'Steer the current reply',
    detail:
      'Your message joins the current reply as soon as the Agent finishes its running steps.',
  },
  {
    value: 'queue',
    label: 'Queue as the next message',
    detail:
      'Your message waits until the current reply finishes, then is sent on its own.',
  },
];

/** What a message sent while the Agent works does; saved to the account. */
function MessageModeCard() {
  const { api, origin } = useSession();
  const queryClient = useQueryClient();
  const key = [origin, 'agent-message-mode'];
  const mode = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api!.agentMessageMode(signal),
    enabled: Boolean(api),
  });
  const save = useMutation({
    mutationFn: (value: AgentMessageMode) => api!.setAgentMessageMode(value),
    onSuccess: (value) => queryClient.setQueryData(key, value),
    onError: (error) =>
      Alert.alert('Couldn’t save the preference', errorText(error)),
  });
  const value = save.isPending ? save.variables : mode.data;
  const chosen = MESSAGE_MODES.find((item) => item.value === value);
  return (
    <Card style={{ gap: 10 }}>
      <Text style={type.heading}>Messages sent while your Agent works</Text>
      {mode.error ? (
        <Text style={type.small}>{errorText(mode.error)}</Text>
      ) : (
        <>
          <Choice
            label="Messages sent while your Agent works"
            value={value ?? ''}
            options={MESSAGE_MODES.map(({ value, label }) => ({
              value,
              label,
            }))}
            disabled={!mode.data || save.isPending}
            onChange={(next) => save.mutate(next as AgentMessageMode)}
          />
          {chosen ? <Text style={type.small}>{chosen.detail}</Text> : null}
        </>
      )}
    </Card>
  );
}

export default function SettingsScreen() {
  const { origin, disconnect } = useSession();
  const [busy, setBusy] = useState(false);
  const host = origin?.replace(/^https?:\/\//, '') ?? '';
  const signOut = () =>
    Alert.alert(
      'Sign out of this instance?',
      'This removes the saved session from this phone and closes your app views.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            void disconnect()
              .catch((error: unknown) =>
                Alert.alert('Check device access', errorText(error)),
              )
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  return (
    <ScrollView
      {...pageScrollProps}
      style={{ flex: 1, backgroundColor: c.ground }}
      contentContainerStyle={{ ...readable, paddingBottom: 32 }}
    >
      {/* Close leads the sheet's bar: horizontal at the top here, first on
          the vertical bar where iPhone Duo puts the bar on the side. */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon={glyphs.close} onPress={() => router.back()}>
          Close
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Masthead nested eyebrow="Connected instance" title="Your instance" />
      <View style={{ paddingHorizontal: 16, gap: 14 }}>
        <Card style={{ gap: 14 }}>
          <Tag tone="success" dot label="Signed in on this phone" />
          <Text selectable style={type.title}>
            {host}
          </Text>
          <Button
            variant="secondary"
            glyph="browser"
            label="Open Hatch on the web"
            fullWidth
            onPress={() => {
              if (origin)
                void WebBrowser.openBrowserAsync(origin).catch(
                  (error: unknown) =>
                    Alert.alert('Couldn’t open browser', errorText(error)),
                );
            }}
          />
        </Card>
        <MessageModeCard />
        <Card style={{ gap: 18 }}>
          {notes.map((note) => (
            <View
              key={note.title}
              style={{
                flexDirection: 'row',
                gap: 14,
                alignItems: 'flex-start',
              }}
            >
              <GlyphTile glyph={note.glyph} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={type.heading}>{note.title}</Text>
                <Text style={type.small}>{note.detail}</Text>
              </View>
            </View>
          ))}
        </Card>
        <Button
          variant="danger"
          glyph="signOut"
          label={busy ? 'Signing out…' : 'Sign out'}
          busy={busy}
          fullWidth
          onPress={signOut}
        />
        <Button fullWidth label="Done" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}
