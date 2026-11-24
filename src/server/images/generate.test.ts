import { readdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/hatch-image-test-${process.pid}-${Date.now()}`;
  process.env.HATCH_DATA_DIR = dir;
  return dir;
});
const model = vi.hoisted(() => ({
  resolveImageModel: vi.fn<
    (imageModelId?: string) => Promise<{
      id: string;
      driver: { suggestedModels: string[]; generate: () => Promise<Buffer> };
      provider: { baseUrl: string; apiKey: string };
      modelId: string;
    }>
  >(),
}));
vi.mock('./model', () => model);

const { IMAGE_CANDIDATES_DIR } = await import('~agent/paths');
const { imageDriverFor } = await import('./drivers');
const { readCandidate } = await import('./candidates');
const { composeGlyphTile, composeSubjectTile } = await import('./tile');

const KEY = 'sk-test-secret-value';
const provider = { baseUrl: 'https://images.example.test/v1/', apiKey: KEY };

/** A white ring on black, the drawing the icon prompt asks a model for. */
async function glyph(): Promise<Buffer> {
  const ring = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">' +
      '<rect width="400" height="400" fill="#000"/>' +
      '<circle cx="230" cy="170" r="60" fill="none" stroke="#fff" stroke-width="20"/></svg>',
  );
  return sharp(ring).png().toBuffer();
}
/**
 * An off-centre red disc on a transparent ground, the cut-out the subject
 * prompt asks for. Models top out just under full opacity.
 */
async function cutout(alpha = 253): Promise<Buffer> {
  const disc = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">' +
      `<circle cx="140" cy="250" r="80" fill="#ff0000" fill-opacity="${alpha / 255}"/></svg>`,
  );
  return sharp(disc).png().toBuffer();
}
const pixel = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [...data.subarray(offset, offset + 3)];
};

async function freshGenerate() {
  vi.resetModules();
  return (await import('./generate')).generateImages;
}

beforeEach(async () => {
  const drawing = await glyph();
  model.resolveImageModel.mockResolvedValue({
    driver: {
      suggestedModels: [],
      generate: vi.fn<() => Promise<Buffer>>(async () => drawing),
    },
    id: 'image-model-1',
    provider,
    modelId: 'test-image-model',
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => rm(dataDir, { recursive: true, force: true }));

describe('composeGlyphTile', () => {
  it('lays the glyph centred on a gradient of the colour', async () => {
    const tile = await composeGlyphTile(await glyph(), '#3E63DD');
    const meta = await sharp(tile).metadata();

    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([512, 512, false]);
    // The ground is the requested colour, whatever the model drew: lighter
    // at the top than at the bottom, and still blue.
    const [top, bottom] = [await pixel(tile, 4, 4), await pixel(tile, 4, 507)];
    expect(top[2]).toBeGreaterThan(bottom[2]);
    expect(bottom[2]).toBeGreaterThan(bottom[0]);
    // The off-centre ring was re-centred and scaled to the fixed share.
    expect(await pixel(tile, 256, 256 - 135)).toEqual([255, 255, 255]);
    expect(await pixel(tile, 256, 256)).not.toEqual([255, 255, 255]);
  });

  it('rejects drawings that are not a white glyph on black', async () => {
    const blank = { width: 64, height: 64, channels: 3 as const };
    for (const background of ['#000000', '#FFFFFF'])
      await expect(
        composeGlyphTile(
          await sharp({ create: { ...blank, background } })
            .png()
            .toBuffer(),
          '#3E63DD',
        ),
      ).rejects.toMatchObject({ status: 400 });
    await expect(composeGlyphTile(await glyph(), 'blue')).rejects.toMatchObject(
      { status: 400 },
    );
  });
});

describe('composeSubjectTile', () => {
  it('centres the cut-out at a fixed size on a gradient of the colour', async () => {
    const tile = await composeSubjectTile(await cutout(), '#3E63DD');
    const meta = await sharp(tile).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([512, 512, false]);

    // The off-centre disc was re-centred, scaled up and made fully opaque.
    expect(await pixel(tile, 256, 256)).toEqual([255, 0, 0]);
    expect(await pixel(tile, 256, 256 - 170)).toEqual([255, 0, 0]);
    // The ground is the colour, lighter at the top than at the bottom.
    const [top, bottom] = [await pixel(tile, 4, 4), await pixel(tile, 4, 507)];
    expect(top[2]).toBeGreaterThan(bottom[2]);
    expect(top[2]).toBeGreaterThan(top[0]);
    expect(bottom[2]).toBeGreaterThan(bottom[0]);
  });

  it('rejects images that are not a cut-out subject', async () => {
    const square = { width: 64, height: 64 };
    const inputs = [
      // Opaque pictures: the model ignored the transparent background.
      await sharp({ create: { ...square, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
      await composeGlyphTile(await glyph(), '#3E63DD'),
      // Nothing drawn.
      await sharp({
        create: { ...square, channels: 4, background: '#0000' },
      })
        .png()
        .toBuffer(),
    ];
    for (const input of inputs)
      await expect(composeSubjectTile(input, '#3E63DD')).rejects.toMatchObject({
        status: 400,
      });
    await expect(
      composeSubjectTile(await cutout(), 'blue'),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('generateImages', () => {
  it('stores re-encoded candidates that can be read back by id', async () => {
    const generateImages = await freshGenerate();
    const result = await generateImages({
      prompt: 'a ring',
      count: 2,
      glyphTile: '#E5484D',
    });

    expect(result.model).toBe('test-image-model');
    expect(result.images).toHaveLength(2);
    for (const candidate of result.images) {
      expect(candidate.path).toBe(`/api/images/candidates/${candidate.id}`);
      const stored = await readCandidate(candidate.id);
      const [red, green, blue] = await pixel(stored!, 256, 500);
      expect(red).toBeGreaterThan(green);
      expect(red).toBeGreaterThan(blue);
    }
    expect(await readdir(IMAGE_CANDIDATES_DIR)).toHaveLength(2);
    expect(await readCandidate('../../etc/passwd')).toBeNull();
  });

  it('bounds every request before spending provider credit', async () => {
    const generateImages = await freshGenerate();
    const { driver } = await model.resolveImageModel();
    const rejected = [
      { prompt: '   ' },
      { prompt: 'x'.repeat(4001) },
      { prompt: 'x', count: 0 },
      { prompt: 'x', count: 5 },
      { prompt: 'x', count: 1.5 },
      { prompt: 'x', glyphTile: 'red' },
      { prompt: 'x', subjectTile: 'red' },
      { prompt: 'x', glyphTile: '#E5484D', subjectTile: '#E5484D' },
    ];
    for (const input of rejected)
      await expect(generateImages(input)).rejects.toMatchObject({
        status: 400,
      });
    expect(driver.generate).not.toHaveBeenCalled();
  });

  it('asks for a transparent background only for subject tiles', async () => {
    const generateImages = await freshGenerate();
    const { driver } = await model.resolveImageModel();
    const generate = vi.mocked(driver.generate);
    generate.mockResolvedValueOnce(await cutout());
    await generateImages({ prompt: 'a disc', subjectTile: '#2F9E68' });
    await generateImages({ prompt: 'a ring', glyphTile: '#2F9E68' });

    const backgrounds = generate.mock.calls.map(
      (call) => (call as unknown[])[1] as { background: string },
    );
    expect(backgrounds.map((request) => request.background)).toEqual([
      'transparent',
      'opaque',
    ]);
  });

  it('stops at the hourly image limit', async () => {
    const generateImages = await freshGenerate();
    const { driver } = await model.resolveImageModel();
    // 7 calls of 4 fit under the limit of 30; the 8th would exceed it.
    for (let call = 0; call < 7; call += 1)
      await generateImages({ prompt: 'x', count: 4 });
    await expect(
      generateImages({ prompt: 'x', count: 4 }),
    ).rejects.toMatchObject({ status: 429 });
    expect(driver.generate).toHaveBeenCalledTimes(28);
  });
});

describe('OpenAI image driver', () => {
  const driver = imageDriverFor('openai-responses')!;
  const request = {
    model: 'test-image-model',
    prompt: 'a ring',
    quality: 'low' as const,
    background: 'opaque' as const,
    signal: new AbortController().signal,
  };

  it('sends only the prompt and fixed bounds, with the key in a header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect((await driver.generate(provider, request)).toString()).toBe('hello');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://images.example.test/v1/images/generations');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'test-image-model',
      prompt: 'a ring',
      n: 1,
      size: '1024x1024',
      quality: 'low',
      background: 'opaque',
      output_format: 'png',
    });
    expect(String(init?.body)).not.toContain(KEY);
  });

  it('reports provider rejections without leaking the API key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json(
          { error: { message: `Incorrect API key provided: ${KEY}` } },
          { status: 401 },
        ),
      ),
    );
    const error = await driver.generate(provider, request).catch((e) => e);

    expect(error).toMatchObject({ status: 400 });
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain(KEY);

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () => new Response('upstream down', { status: 502 }),
      ),
    );
    await expect(driver.generate(provider, request)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('stops reading a provider response larger than one image', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x41);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(body)),
    );

    await expect(driver.generate(provider, request)).rejects.toMatchObject({
      status: 503,
    });
    // An endless body is abandoned shortly after the limit, not drained.
    expect(sent).toBeLessThan(40);
  });

  it('offers no driver for providers that cannot generate images', () => {
    expect(imageDriverFor('anthropic-messages')).toBeNull();
  });
});
