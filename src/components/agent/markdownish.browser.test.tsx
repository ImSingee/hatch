import { MantineProvider } from '@mantine/core';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { Markdownish } from './markdownish';

test('keeps code block lines aligned without applying inline code decoration', async () => {
  const screen = await render(
    <MantineProvider>
      <div style={{ width: 300 }}>
        <Markdownish
          text={[
            'Use `hatch app list`:',
            '',
            '```sh',
            'hatch app list',
            'hatch app get <id>',
            `hatch app deploy --message "${'long command '.repeat(20)}"`,
            '```',
          ].join('\n')}
        />
      </div>
    </MantineProvider>,
  );
  const pre = screen.container.querySelector('pre')!;
  const code = pre.querySelector('code')!;
  const inline = screen.container.querySelector('p code')!;
  const style = getComputedStyle(code);
  const preStyle = getComputedStyle(pre);
  const text = code.firstChild!;
  const lineStart = (offset: number) => {
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    return range.getBoundingClientRect().left;
  };

  expect(lineStart(0)).toBeCloseTo(
    lineStart(text.textContent!.indexOf('\n') + 1),
    1,
  );
  expect(style.fontSize).toBe(preStyle.fontSize);
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(style.paddingLeft).toBe('0px');
  expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
  expect(pre.getBoundingClientRect().width).toBeLessThanOrEqual(300);
  expect(getComputedStyle(inline).paddingLeft).not.toBe('0px');
  expect(getComputedStyle(inline).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
});

const imageSources = async (text: string) => {
  const screen = await render(
    <MantineProvider>
      <Markdownish text={text} />
    </MantineProvider>,
  );
  return [...screen.container.querySelectorAll('img')].map((image) =>
    image.getAttribute('src'),
  );
};

test('shows only images stored by the platform', async () => {
  const candidate = `/api/images/candidates/${'a'.repeat(32)}`;
  const icon = '/api/app/01abc/icon?v=01key&size=128';
  expect(await imageSources(`A ![A](${candidate}) ![icon](${icon})`)).toEqual([
    candidate,
    icon,
  ]);
  // Model output must never make the browser call an arbitrary URL.
  expect(
    await imageSources(
      [
        '![x](https://evil.example/track.png?secret=1)',
        '![x](//evil.example/a.png)',
        '![x](/api/auth/sign-out)',
        `![x](${candidate}/../../auth/sign-out)`,
        '![x](/api/images/candidates/short)',
        '![x](data:image/png;base64,AAAA)',
      ].join('\n\n'),
    ),
  ).toEqual([]);
});

test('keeps dollar amounts and escaped brackets literal when math is off', async () => {
  const text = 'Refunds cost $5 and orders $10.\n\nMatch \\[a-z\\] ids.';
  const screen = await render(
    <MantineProvider>
      <Markdownish text={text} math={false} />
    </MantineProvider>,
  );
  expect(screen.container.querySelector('.katex')).toBeNull();
  expect(screen.container.textContent).toContain(
    'Refunds cost $5 and orders $10.',
  );
  expect(screen.container.textContent).toContain('Match [a-z] ids.');
});
