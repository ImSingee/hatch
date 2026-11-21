import { describe, expect, it } from 'vitest';
import { assertIconFile, parseImageCommand } from './image';

const command = (...args: string[]) => parseImageCommand(args, 0).command;
const rejected = (...args: string[]) => {
  try {
    parseImageCommand(args, 0);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'accepted';
};
const CANDIDATE = 'a'.repeat(32);

describe('image command arguments', () => {
  it('maps each command to one explicit operation', () => {
    expect(command('image-model', 'get')).toEqual({ kind: 'model-get' });
    expect(command('image-model', 'clear')).toEqual({ kind: 'model-clear' });
    expect(
      command('image-model', 'set', '--provider', 'p1', '--model', 'gpt-x'),
    ).toEqual({ kind: 'model-set', providerId: 'p1', modelId: 'gpt-x' });
    expect(
      command(
        'image',
        'generate',
        '--prompt-file',
        '-',
        '--count',
        '3',
        '--quality',
        'medium',
        '--glyph-tile',
        '#3E63DD',
        '--output-dir',
        'out',
      ),
    ).toEqual({
      kind: 'generate',
      prompt: undefined,
      promptFile: '-',
      count: 3,
      quality: 'medium',
      glyphTile: '#3E63DD',
      outputDir: 'out',
    });
    // The limit counts code points, like the public API.
    expect(
      command('image', 'generate', '--prompt', '\u{1F600}'.repeat(4000)),
    ).toMatchObject({ kind: 'generate' });
    expect(command('image', 'generate', '--prompt', 'a ring')).toMatchObject({
      prompt: 'a ring',
      count: 1,
    });
    expect(command('app', 'icon', 'get', 'my-app')).toEqual({
      kind: 'icon-get',
      id: 'my-app',
    });
    expect(command('app', 'icon', 'clear', 'my-app')).toEqual({
      kind: 'icon-clear',
      id: 'my-app',
    });
    expect(
      command('app', 'icon', 'set', 'my-app', '--candidate', CANDIDATE),
    ).toEqual({
      kind: 'icon-set',
      id: 'my-app',
      file: undefined,
      candidateId: CANDIDATE,
    });
  });

  it('keeps global options that precede the command', () => {
    const parsed = parseImageCommand(
      ['--json', '--timeout', '9', 'app', 'icon', 'get', 'my-app'],
      3,
    );
    expect(parsed.command).toEqual({ kind: 'icon-get', id: 'my-app' });
    expect(parsed.flags).toMatchObject({ json: true, timeout: '9' });
  });

  it('rejects ambiguous or unusable input before any request', () => {
    const cases: string[][] = [
      ['image-model', 'set', '--provider', 'p1'],
      ['image-model', 'set', '--provider', 'p1', '--model', 'bad id'],
      ['image-model', 'get', 'extra'],
      ['image-model', 'rotate'],
      ['image', 'generate'],
      ['image', 'generate', '--prompt', 'a', '--prompt-file', 'b'],
      ['image', 'generate', '--prompt', ''],
      ['image', 'generate', '--prompt', 'x'.repeat(4001)],
      ['image', 'generate', '--prompt', 'a', '--count', '0'],
      ['image', 'generate', '--prompt', 'a', '--count', '5'],
      ['image', 'generate', '--prompt', 'a', '--count', '2.5'],
      ['image', 'generate', '--prompt', 'a', '--quality', 'ultra'],
      ['image', 'generate', '--prompt', 'a', '--glyph-tile', 'blue'],
      ['image', 'generate', '--prompt', 'a', '--unknown'],
      ['app', 'icon', 'set', 'my-app'],
      ['app', 'icon', 'set', 'my-app', '--file', 'a', '--candidate', CANDIDATE],
      ['app', 'icon', 'set', 'my-app', '--candidate', 'not-an-id'],
      ['app', 'icon', 'set', '--file', 'a'],
      ['app', 'icon', 'get'],
      ['app', 'icon', 'get', 'a', 'b'],
      ['app', 'icon', 'generate', 'my-app'],
    ];
    expect(
      cases.filter((args) => rejected(...args) !== 'invalid_arguments'),
    ).toEqual([]);
  });
});

describe('icon file check', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const code = (bytes: Uint8Array) => {
    try {
      assertIconFile(bytes);
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'accepted';
  };

  it('accepts PNG, JPEG and WebP signatures only, up to 4 MB', () => {
    expect(code(png)).toBe('accepted');
    expect(code(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('accepted');
    expect(code(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe(
      'accepted',
    );
    expect(code(Buffer.from('<svg xmlns="x"/>'))).toBe('invalid_input');
    expect(code(Buffer.from('GIF89a......'))).toBe('invalid_input');
    expect(code(new Uint8Array())).toBe('invalid_input');
    expect(code(Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]))).toBe(
      'input_too_large',
    );
  });
});
