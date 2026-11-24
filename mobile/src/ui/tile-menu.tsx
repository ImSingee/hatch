import { Host } from '@expo/ui';
import {
  Box,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPopup,
  Text,
} from '@expo/ui/jetpack-compose';
import { fillMaxSize } from '@expo/ui/jetpack-compose/modifiers';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { palette as c } from './theme';
import type { TileMenuProps } from './tile-menu.types';

/**
 * A tile with a Material menu anchored to it: touching and holding opens it,
 * and a tap still reaches the tile. The tile stays a plain React Native view
 * so drags that start on it still scroll and pull to refresh; the Compose
 * host only lies behind it, the size of the tile, to anchor the menu.
 */
export function TileMenu({ actions, children }: TileMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Host style={StyleSheet.absoluteFill} pointerEvents="none">
        <Box modifiers={[fillMaxSize()]}>
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
      {children(() => setOpen(true))}
    </View>
  );
}
