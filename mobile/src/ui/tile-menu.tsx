import { Host } from '@expo/ui';
import {
  Box,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPopup,
  RNHostView,
  Text,
} from '@expo/ui/jetpack-compose';
import { useState } from 'react';
import { palette as c } from './theme';
import type { TileMenuProps } from './tile-menu.types';

/**
 * A tile with a Material menu anchored to it: touching and holding opens it,
 * and a tap still reaches the tile.
 */
export function TileMenu({ actions, children }: TileMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <Host matchContents>
      <Box>
        <RNHostView matchContents>{children(() => setOpen(true))}</RNHostView>
        <DropdownMenuPopup
          expanded={open}
          onDismissRequest={() => setOpen(false)}
          anchorPosition="below"
        >
          <DropdownMenuGroup containerColor={c.card}>
            {actions.map((action, index) => (
              <DropdownMenuItem
                key={action.label}
                shape={{ index, count: actions.length }}
                elementColors={
                  action.destructive ? { textColor: c.danger } : undefined
                }
                onClick={() => {
                  setOpen(false);
                  action.onPress();
                }}
              >
                <DropdownMenuItem.Text>
                  <Text>{action.label}</Text>
                </DropdownMenuItem.Text>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuPopup>
      </Box>
    </Host>
  );
}
