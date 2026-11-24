/**
 * Drives the gallery in the web player and fails on anything the runtime
 * reports: an error, or a class it cannot resolve (`[nsh] unknown classes`),
 * which is how a class from a lookup table that names no token shows up.
 * Every section is shown and every popup opened, in each layout and accent,
 * and a screenshot of each is written: the catalogue screenshot suite.
 *
 *   node_modules/.bin/tsx sdk-internal/ui/gallery/check.ts <out-dir> [url]
 *
 * after building the gallery and starting `serve.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const out = path.resolve(process.argv[2] ?? 'gallery-shots');
const base = process.argv[3] ?? 'http://127.0.0.1:8791/';
const accents = ['indigo', 'teal', 'clay', 'violet'] as const;

type Layout = {
  name: string;
  width: number;
  height: number;
  idiom?: 'phone' | 'desktop';
  touch?: boolean;
};

const layouts: Layout[] = [
  { name: 'desktop-1280', width: 1280, height: 900, idiom: 'desktop' },
  { name: 'desktop-390', width: 390, height: 844, idiom: 'desktop' },
  { name: 'phone-390', width: 390, height: 844, idiom: 'phone', touch: true },
];

const sections = [
  'Basics',
  'Inputs',
  'Data',
  'Feedback',
  'Navigation',
  'Patterns',
];

/** `ONLY=phone-390:teal` limits a run to one layout and accent. */
const only = process.env.ONLY?.split(':');

const problems: string[] = [];

function watch(page: Page, context: string): void {
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' ||
      text.includes('unknown class') ||
      text.includes('@hatch/ui')
    ) {
      problems.push(`${context}: [${message.type()}] ${text}`);
    }
  });
  page.on('pageerror', (error) =>
    problems.push(`${context}: ${error.message}`),
  );
}

async function open(page: Page, layout: Layout, accent: string): Promise<void> {
  const url = new URL(base);
  url.searchParams.set('accent', accent);
  if (layout.idiom) url.searchParams.set('idiom', layout.idiom);
  await page.goto(url.href);
  await page.waitForFunction(
    () => (window as { galleryReady?: boolean }).galleryReady,
  );
  await page.getByRole('tab', { name: 'Basics', exact: true }).waitFor();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
}

async function section(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click();
  await page.waitForTimeout(150);
}

async function close(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

/** Opens each kind of popup, so their classes are resolved and seen. */
async function popups(page: Page, prefix: string): Promise<void> {
  await section(page, 'Inputs');
  await page
    .getByRole('combobox', { name: 'Plot', exact: true })
    .first()
    .click();
  await shot(page, `${prefix}-select`);
  await close(page);
  await page.getByRole('combobox', { name: 'Sown on', exact: true }).click();
  await shot(page, `${prefix}-date-picker`);
  await close(page);

  await section(page, 'Feedback');
  await page.getByRole('button', { name: 'Open dialog', exact: true }).click();
  await shot(page, `${prefix}-dialog`);
  await close(page);
  await page.getByRole('button', { name: 'Open sheet', exact: true }).click();
  await shot(page, `${prefix}-sheet`);
  await close(page);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await shot(page, `${prefix}-menu`);
  await close(page);
  await page.getByRole('button', { name: 'Success', exact: true }).click();
  await page.getByRole('button', { name: 'With undo', exact: true }).click();
  await shot(page, `${prefix}-toasts`);
}

async function patterns(page: Page, prefix: string): Promise<void> {
  await section(page, 'Patterns');
  for (const [entry, name] of [
    ['Dashboard', 'dashboard'],
    ['Records', 'records'],
    ['New plant', 'form'],
    ['Settings', 'settings'],
  ] as const) {
    await page.getByRole('button', { name: new RegExp(`^${entry}`) }).click();
    await shot(page, `${prefix}-pattern-${name}`);
    await page
      .getByRole('button', { name: 'Back', exact: true })
      .first()
      .click();
    await page.waitForTimeout(250);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const layout of layouts) {
      for (const accent of accents) {
        if (
          only &&
          (only[0] !== layout.name || (only[1] && only[1] !== accent))
        ) {
          continue;
        }
        const context = await browser.newContext({
          viewport: { width: layout.width, height: layout.height },
          hasTouch: layout.touch,
        });
        const page = await context.newPage();
        const prefix = `${layout.name}-${accent}`;
        watch(page, prefix);
        await open(page, layout, accent);
        for (const name of sections) {
          await section(page, name);
          await shot(page, `${prefix}-${name.toLowerCase()}`);
        }
        await popups(page, prefix);
        await patterns(page, prefix);
        await context.close();
        console.log(`checked ${prefix}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`no runtime problems; screenshots in ${out}`);
}

await main();
