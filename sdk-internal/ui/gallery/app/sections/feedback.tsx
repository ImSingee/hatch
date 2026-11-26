import {
  AlertDialog,
  Button,
  Card,
  Dialog,
  IconArrowUp,
  IconCopy,
  IconInfoCircle,
  IconPencil,
  IconSortAscending,
  IconTrash,
  Icon,
  Menu,
  Tooltip,
  Page,
  Row,
  Sheet,
  Stack,
  Text,
  TextField,
  Toast,
  signal,
} from '@hatch/ui';

export function Feedback() {
  const dialog = signal(false);
  const sheet = signal(false);
  const answer = signal('No answer yet.');
  return (
    <Page
      title="Feedback"
      description="Dialogs, sheets, confirmations and toasts."
    >
      <Card title="Dialog and sheet">
        <Row wrap>
          <Button label="Open dialog" onPress={() => dialog.set(true)} />
          <Button label="Open sheet" onPress={() => sheet.set(true)} />
        </Row>
        <Dialog
          open={dialog()}
          onOpenChange={dialog.set}
          title="Rename the bed"
          description="The new name shows on every plant in it."
          actions={
            <>
              <Button label="Cancel" onPress={() => dialog.set(false)} />
              <Button
                label="Rename"
                kind="primary"
                onPress={() => dialog.set(false)}
              />
            </>
          }
        >
          <TextField label="Name" value="North bed" />
        </Dialog>
        <Sheet
          open={sheet()}
          onOpenChange={sheet.set}
          title="Filter plants"
          description="Show only the plants that match."
          actions={
            <Button
              label="Done"
              kind="primary"
              onPress={() => sheet.set(false)}
            />
          }
        >
          <Stack gap="md">
            <TextField label="Name contains" placeholder="tom" />
          </Stack>
        </Sheet>
      </Card>

      <Card title="Confirm">
        <Row wrap>
          <Button
            label="Delete bed…"
            kind="danger"
            onPress={async () => {
              const confirmed = await AlertDialog.confirm({
                title: 'Delete North bed?',
                description: 'Its 12 plants and their notes are deleted too.',
                confirmLabel: 'Delete',
                destructive: true,
              });
              answer.set(confirmed ? 'Deleted.' : 'Kept.');
            }}
          />
          <Button
            label="Show notice"
            onPress={() =>
              AlertDialog.alert({
                title: 'Frost tonight',
                description: 'Bring the pots inside before sunset.',
              })
            }
          />
        </Row>
        <Text tone="muted">{answer()}</Text>
      </Card>

      <Card title="Menus and tooltips">
        <Row wrap gap="md">
          <Menu
            label="More actions"
            items={[
              {
                label: 'Rename',
                icon: IconPencil,
                onSelect: () => Toast.show({ title: 'Rename' }),
              },
              {
                label: 'Duplicate',
                icon: IconCopy,
                onSelect: () => Toast.show({ title: 'Duplicate' }),
              },
              'separator',
              {
                label: 'Delete',
                icon: IconTrash,
                destructive: true,
                onSelect: () => Toast.show({ title: 'Delete' }),
              },
            ]}
          />
          <Menu
            label="Sort"
            trigger="button"
            icon={IconSortAscending}
            items={[
              { label: 'Name', checked: true, onSelect: () => {} },
              { label: 'Date planted', onSelect: () => {} },
              {
                label: 'Harvest',
                icon: IconArrowUp,
                disabled: true,
                onSelect: () => {},
              },
            ]}
          />
          <Tooltip label="Sown 12 April, 6 weeks ago">
            <Icon icon={IconInfoCircle} label="About this bed" tone="muted" />
          </Tooltip>
        </Row>
      </Card>

      <Card title="Toasts">
        <Row wrap>
          <Button
            label="Neutral"
            onPress={() => Toast.show({ title: 'Copied the plot code' })}
          />
          <Button
            label="Success"
            onPress={() =>
              Toast.success('Watering logged', 'North bed, 6 litres')
            }
          />
          <Button
            label="Error"
            onPress={() =>
              Toast.error(
                'Could not sync',
                'Check the connection and try again.',
              )
            }
          />
          <Button
            label="With undo"
            onPress={() =>
              Toast.show({
                title: 'Note deleted',
                action: {
                  label: 'Undo',
                  onPress: () => Toast.show({ title: 'Note restored' }),
                },
              })
            }
          />
        </Row>
      </Card>
    </Page>
  );
}
