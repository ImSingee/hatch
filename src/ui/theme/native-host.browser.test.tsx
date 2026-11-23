import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { useNativeHostDocument } from './native-host';

function NativeHostPage() {
  useNativeHostDocument();
  return <p>Widgets</p>;
}

// The native app draws the desk ground behind the WebView; a page that paints
// its own ground would cover the app's shapes with a flat rectangle.
test('a native-host page paints no ground and the web desk keeps it', async () => {
  // The ground as the web desk paints it (Mantine's body rule).
  const ground = document.createElement('style');
  ground.textContent = 'body { background-color: rgb(237, 235, 230); }';
  document.head.append(ground);
  const screen = await render(<NativeHostPage />);
  expect(document.documentElement.dataset.host).toBe('native');
  expect(getComputedStyle(document.body).backgroundColor).toBe(
    'rgba(0, 0, 0, 0)',
  );

  await screen.unmount();
  expect(document.documentElement.dataset.host).toBeUndefined();
  expect(getComputedStyle(document.body).backgroundColor).toBe(
    'rgb(237, 235, 230)',
  );
  ground.remove();
});
