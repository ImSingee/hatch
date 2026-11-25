import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { DRAG_HANDLE_ATTRIBUTE, SortableList } from './sortable-list';

const handle = { [DRAG_HANDLE_ATTRIBUTE]: '' };

test('a handle list drags from its handle only, and nested lists stay apart', async () => {
  const outer = vi.fn<(ids: string[]) => void>();
  const inner = vi.fn<(ids: string[]) => void>();
  const screen = await render(
    <SortableList
      handle
      items={[{ id: 'a' }, { id: 'b' }]}
      onReorder={outer}
      renderItem={(group) => (
        <section style={{ padding: 8 }}>
          <button type="button" aria-label={`grip ${group.id}`} {...handle}>
            ≡
          </button>
          <span>group {group.id}</span>
          <SortableList
            handle
            items={[{ id: `${group.id}1` }, { id: `${group.id}2` }]}
            onReorder={inner}
            renderItem={(row, controls) => (
              <div style={{ padding: 4 }}>
                <button
                  type="button"
                  aria-label={`grip ${row.id}`}
                  {...handle}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') controls.move(1);
                  }}
                >
                  ≡
                </button>
                <span>row {row.id}</span>
              </div>
            )}
          />
        </section>
      )}
    />,
  );

  // Dragging from the text is not a reorder.
  await userEvent.dragAndDrop(
    screen.getByText('group b'),
    screen.getByText('group a'),
  );
  expect(outer).not.toHaveBeenCalled();

  // A row's handle reorders its own list, not the group around it.
  await userEvent.dragAndDrop(
    screen.getByRole('button', { name: 'grip a2' }),
    screen.getByRole('button', { name: 'grip a1' }),
  );
  expect(inner).toHaveBeenLastCalledWith(['a2', 'a1']);
  expect(outer).not.toHaveBeenCalled();

  await userEvent.dragAndDrop(
    screen.getByRole('button', { name: 'grip b' }),
    screen.getByRole('button', { name: 'grip a' }),
  );
  expect(outer).toHaveBeenLastCalledWith(['b', 'a']);

  // The keyboard moves a row one place.
  inner.mockClear();
  await userEvent.click(screen.getByRole('button', { name: 'grip b1' }));
  await userEvent.keyboard('{ArrowDown}');
  expect(inner).toHaveBeenLastCalledWith(['b2', 'b1']);
});

test('quick key presses build on the order just submitted', async () => {
  const onReorder = vi.fn<(ids: string[]) => void>();
  // The caller's update lands later, so `items` stays as it was.
  const screen = await render(
    <SortableList
      handle
      items={[{ id: 'a' }, { id: 'b' }, { id: 'c' }]}
      onReorder={onReorder}
      renderItem={(row, controls) => (
        <button
          type="button"
          aria-label={`grip ${row.id}`}
          {...handle}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') controls.move(1);
          }}
        >
          {row.id}
        </button>
      )}
    />,
  );

  await userEvent.click(screen.getByRole('button', { name: 'grip a' }));
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
  expect(onReorder.mock.calls).toEqual([[['b', 'a', 'c']], [['b', 'c', 'a']]]);
});
