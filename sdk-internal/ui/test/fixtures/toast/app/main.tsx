import { Button, Page, Stack, Text, Toast, mount, signal } from '@hatch/ui';

function App() {
  const notes = signal(['Water the beans']);
  return (
    <Page title="Notes">
      <Stack>
        <Text>{notes().length === 0 ? 'No notes' : notes().join(', ')}</Text>
        <Button
          label="Delete note"
          onPress={() => {
            const removed = notes();
            notes.set([]);
            Toast.show({
              title: 'Note deleted',
              action: { label: 'Undo', onPress: () => notes.set(removed) },
            });
          }}
        />
        <Button
          label="Delete quietly"
          onPress={() =>
            Toast.show({
              title: 'Cannot undo',
              action: {
                label: 'Undo',
                disabled: true,
                onPress: () => notes.set([]),
              },
            })
          }
        />
      </Stack>
    </Page>
  );
}

mount(App);
