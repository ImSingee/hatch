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

/** Moves the shown page's scroll view (the tallest one) to `top`; returns
 * whether more lies below what is now shown. */
function scrollPage(page: Page, top: number): Promise<boolean> {
  return page.evaluate((offset) => {
    const view = [...document.querySelectorAll<HTMLElement>('.nsh-scroll')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 200 && element.scrollHeight > element.clientHeight;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!view) return false;
    view.scrollTop = offset;
    return view.scrollTop + view.clientHeight < view.scrollHeight - 1;
  }, top);
}

/** Screenshots a whole section, one viewport at a time, top to bottom. */
async function sectionShots(
  page: Page,
  name: string,
  layout: Layout,
): Promise<void> {
  const stride = Math.round(layout.height * 0.85);
  for (let part = 1; part <= 12; part += 1) {
    const more = await scrollPage(page, (part - 1) * stride);
    await shot(page, `${name}-${part}`);
    if (!more) break;
  }
  await scrollPage(page, 0);
}

/** Scrolls the element `locator` names into the middle of the view. */
async function reveal(
  page: Page,
  label: string,
  role: 'button' | 'combobox' = 'button',
) {
  const target = page.getByRole(role, { name: label, exact: true }).first();
  await target.evaluate((element) =>
    element.scrollIntoView({ block: 'center' }),
  );
  await page.waitForTimeout(150);
  return target;
}

async function close(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

/** Opens each kind of popup, so their classes are resolved and seen, and
 * answers the confirmations. */
async function popups(
  page: Page,
  prefix: string,
  layout: Layout,
): Promise<void> {
  await section(page, 'Inputs');
  await (await reveal(page, 'Plot', 'combobox')).click();
  await shot(page, `${prefix}-select`);
  await close(page);
  await (await reveal(page, 'Plot, searchable', 'combobox')).click();
  await shot(page, `${prefix}-select-search`);
  await close(page);
  const tags = page.getByRole('combobox', { name: 'Tags', exact: true });
  await tags.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await tags.click();
  await page.keyboard.type('er');
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-combobox`);
  await close(page);
  await (await reveal(page, 'Sown on', 'combobox')).click();
  await shot(page, `${prefix}-date-picker`);
  await close(page);
  await (await reveal(page, 'Next watering', 'combobox')).click();
  await shot(page, `${prefix}-date-time-picker`);
  await close(page);
  await scrollPage(page, 0);

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
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  await shot(page, `${prefix}-menu-sort`);
  await close(page);
  if (!layout.touch) {
    await page
      .getByRole('img', { name: 'About this bed', exact: true })
      .hover();
    await page.waitForTimeout(900);
    await shot(page, `${prefix}-tooltip`);
    await page.mouse.move(0, 0);
  }

  // Confirm: answer it, and check the App got the answer.
  await page.getByRole('button', { name: 'Delete bed…', exact: true }).click();
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-confirm`);
  await page
    .getByRole('button', { name: 'Delete', exact: true })
    .last()
    .click();
  try {
    await page
      .getByText('Deleted.', { exact: true })
      .waitFor({ timeout: 3000 });
  } catch {
    problems.push(
      `${prefix}: confirming the alert dialog did not report "Deleted."`,
    );
  }
  await page.getByRole('button', { name: 'Show notice', exact: true }).click();
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-alert`);
  await page.getByRole('button', { name: 'OK', exact: true }).last().click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: 'Success', exact: true }).click();
  await page.getByRole('button', { name: 'With undo', exact: true }).click();
  await shot(page, `${prefix}-toasts`);
}

/** The accent changes while the App runs (the `hatch.theme` event), the
 * way an instance setting reaches open Apps. */
async function liveAccent(
  page: Page,
  prefix: string,
  next: string,
): Promise<void> {
  await section(page, 'Basics');
  await page.evaluate((accent) => {
    (window as { setAccent?: (accent: string) => void }).setAccent?.(accent);
  }, next);
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-live-${next}`);
  await section(page, 'Data');
  await shot(page, `${prefix}-live-${next}-data`);
}

/** Heights of the controls a finger presses, in points. */
async function targets(page: Page): Promise<string[]> {
  const measure = async (role: 'button' | 'textbox' | 'tab', name: string) => {
    const box = await page
      .getByRole(role, { name, exact: true })
      .first()
      .boundingBox();
    return `${role} "${name}": ${box ? Math.round(box.height) : 'missing'}`;
  };
  await section(page, 'Inputs');
  const found = [
    await measure('button', 'Add plant'),
    await measure('button', 'Search'),
    await measure('textbox', 'Plant name'),
    await measure('tab', 'Inputs'),
  ];
  await section(page, 'Data');
  found.push(await measure('button', 'North bed, 12 plants'));
  return found;
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
  // A toast on screen must not take Escape from the dialog.
  await page.getByRole('button', { name: 'With undo', exact: true }).click();
  await page.getByRole('button', { name: 'Open dialog', exact: true }).focus();
  await page.keyboard.press('Enter');
  const dialog = page
    .locator('[aria-modal="true"][aria-label="Rename the bed"]')
    .filter({ visible: true });
  await dialog.waitFor();
  // NSH 0.6.1: a Tab pressed in the first moments after a dialog mounts
  // leaves Escape unable to close it; a person takes longer than that.
  await page.waitForTimeout(400);
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
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  if ((await dialog.count()) > 0) {
    await shot(page, `${prefix}-escape`);
    const state = await page.evaluate(() => ({
      tooltips: [...document.querySelectorAll('[role=tooltip]')].map(
        (t) => t.textContent,
      ),
      modals: [...document.querySelectorAll('[aria-modal]')].map((m) =>
        m.getAttribute('aria-label'),
      ),
      focus: document.activeElement?.getAttribute('aria-label'),
    }));
    problems.push(
      `${prefix}: Escape did not close the dialog ${JSON.stringify(state)}`,
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(500);
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
          await sectionShots(page, `${prefix}-${name.toLowerCase()}`, layout);
        }
        if (layout.name === 'desktop-1280') {
          const order = await keyboard(page, prefix);
          fs.writeFileSync(
            path.join(out, `${prefix}-focus-order.txt`),
            order.join('\n'),
          );
        }
        await popups(page, prefix, layout);
        await patterns(page, prefix);
        if (layout.name === 'desktop-1280' && accent === 'indigo') {
          await liveAccent(page, prefix, 'teal');
        }
        if (layout.touch && accent === 'indigo') {
          const heights = await targets(page);
          fs.writeFileSync(
            path.join(out, `${prefix}-touch-targets.txt`),
            heights.join('\n'),
          );
          for (const line of heights) {
            const points = Number(line.split(': ')[1]);
            if (!(points >= 44)) problems.push(`${prefix}: ${line}, below 44`);
          }
        }
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
