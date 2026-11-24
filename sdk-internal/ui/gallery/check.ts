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
/** Behaviour of NSH 0.6.1 itself that the library cannot change; reported,
 * not failed. */
const known: string[] = [];

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

/** What has the keyboard focus: its role and accessible name, and whether it
 * is drawn (a hidden panel must not hold the focus). */
function focused(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return null;
    const box = element.getBoundingClientRect();
    return {
      role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
      name: (element.getAttribute('aria-label') ?? element.textContent ?? '')
        .trim()
        .slice(0, 40),
      visible: box.width > 0 && box.height > 0,
    };
  });
}

/** Walks a section with Tab and checks the focus never lands on a view that
 * is not drawn; returns the focus order for the record. */
async function keyboard(page: Page, prefix: string): Promise<string[]> {
  const order: string[] = [];
  for (const name of ['Inputs', 'Feedback']) {
    await section(page, name);
    await page.getByRole('tab', { name, exact: true }).focus();
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      const now = await focused(page);
      if (!now) continue;
      order.push(`${name}: ${now.role} "${now.name}"`);
      // NSH 0.6.1's Combobox root takes a Tab stop without a name; its input
      // carries the label. Any other unnamed stop is a defect.
      if (!now.name && now.role !== 'combobox') {
        problems.push(`${prefix}: Tab reached a ${now.role} without a name`);
      }
      if (!now.visible) {
        problems.push(
          `${prefix}: Tab reached ${now.role} "${now.name}", which is not drawn`,
        );
      }
    }
  }
  // A dialog takes the focus, Escape closes it, and the focus returns.
  await section(page, 'Feedback');
  await page.getByRole('tab', { name: 'Feedback', exact: true }).focus();
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press('Tab');
    if ((await focused(page))?.name === 'Open dialog') break;
  }
  await page.keyboard.press('Enter');
  const dialog = page
    .locator('[aria-modal="true"][aria-label="Rename the bed"]')
    .filter({ visible: true });
  await dialog.waitFor();
  // NSH 0.6.1's web backdrop is a focusable button without a name; the
  // second Tab reaches the dialog's own controls.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const inside = await focused(page);
  if (inside?.name !== 'Close') {
    problems.push(
      `${prefix}: Tab in the dialog reached ${inside?.role} "${inside?.name}"`,
    );
  }
  // Escape first dismisses the Close button's tooltip, then the dialog.
  for (let press = 0; press < 3 && (await dialog.count()) > 0; press += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
  }
  if ((await dialog.count()) > 0) {
    await shot(page, `${prefix}-escape`);
    problems.push(`${prefix}: Escape did not close the dialog`);
  }
  const back = await focused(page);
  if (back?.name !== 'Open dialog') {
    known.push(
      `${prefix}: after the dialog closed, the focus is on ${back ? `${back.role} "${back.name}"` : 'the page'}, not its opener`,
    );
  }
  return order;
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
        // Keyboard first: a tooltip left under the pointer by the steps
        // below keeps Escape in NSH 0.6.1.
        if (layout.name === 'desktop-1280') {
          const order = await keyboard(page, prefix);
          fs.writeFileSync(
            path.join(out, `${prefix}-focus-order.txt`),
            order.join('\n'),
          );
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
  if (known.length > 0) {
    console.log(`known NSH behaviour:\n${known.join('\n')}`);
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`no runtime problems; screenshots in ${out}`);
}

await main();
