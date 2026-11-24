import { Host } from '@expo/ui';
import { Button, ContextMenu, RNHostView } from '@expo/ui/swift-ui';
import { glyphs } from './glyph.types';
import type { TileMenuProps } from './tile-menu.types';

/**
 * A tile with the system context menu: touching and holding lifts the tile
 * and lists its actions, as on the home screen. A tap still reaches the tile.
 */
export function TileMenu({ actions, children }: TileMenuProps) {
  return (
    <Host colorScheme="light" matchContents>
      <ContextMenu>
        <ContextMenu.Items>
          {actions.map((action) => (
            <Button
              key={action.label}
              label={action.label}
              systemImage={glyphs[action.glyph]}
              role={action.destructive ? 'destructive' : undefined}
              onPress={action.onPress}
            />
          ))}
        </ContextMenu.Items>
        <ContextMenu.Trigger>
          <RNHostView matchContents>{children(undefined)}</RNHostView>
        </ContextMenu.Trigger>
      </ContextMenu>
    </Host>
  );
}
