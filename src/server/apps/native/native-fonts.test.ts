/**
 * The web player's font loader: a font a chunk needs is fetched once and
 * shared, and a failed download is not kept, so a lazily loaded screen whose
 * first `import()` failed gets its font when it is opened again.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFontLoader } from '../../../../sdk-internal/app/src/native-player';

const FONT = 'app/custom/assets/Nunito.woff2';
const URL = '/app/demo/embed/_deployments/d-1/web/assets/Nunito.abc.woff2';
const BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

function loader(fetchFont: (url: string) => Promise<Response>) {
  return createFontLoader((font) => (font === FONT ? URL : null), fetchFont);
}

describe('the native player font loader', () => {
  it('fetches a font again after a network error', async () => {
    const fetchFont = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response(BYTES));
    const { fonts, loadFont } = loader(fetchFont);

    // The first chunk preparation fails with the request.
    await expect(loadFont(FONT)).rejects.toThrow('Failed to fetch');
    expect(fonts.has(FONT)).toBe(false);

    // Opening the screen again prepares the chunk again: a new request.
    await loadFont(FONT);
    expect(fetchFont).toHaveBeenCalledTimes(2);
    expect(fonts.get(FONT)).toEqual(BYTES);
  });

  it('fetches a font again after an answer that is not OK', async () => {
    const fetchFont = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValue(new Response(BYTES));
    const { fonts, loadFont } = loader(fetchFont);

    await loadFont(FONT);
    expect(fonts.has(FONT)).toBe(false);

    await loadFont(FONT);
    expect(fetchFont).toHaveBeenCalledTimes(2);
    expect(fonts.get(FONT)).toEqual(BYTES);
  });

  it('shares one download between callers and keeps it', async () => {
    let answer!: (response: Response) => void;
    const fetchFont = vi.fn<(url: string) => Promise<Response>>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const { fonts, loadFont } = loader(fetchFont);

    // The entry and a chunk ask while the request is in flight.
    const first = loadFont(FONT);
    const second = loadFont(FONT);
    answer(new Response(BYTES));
    await Promise.all([first, second]);
    // A chunk prepared later uses the stored bytes.
    await loadFont(FONT);

    expect(fetchFont).toHaveBeenCalledTimes(1);
    expect(fonts.get(FONT)).toEqual(BYTES);
  });
});
