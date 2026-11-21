import '@fontsource-variable/nunito/wght.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import tokens from '../../packages/hatch-design-tokens/tokens.json';
import logo from '../src-tauri/icons/128x128@2x.png';
import './style.css';

/** Mirrors `Screen` in src-tauri/src/lib.rs. */
type Screen =
  | { step: 'connect'; instance: string | null; error: string | null }
  | { step: 'sign-in'; instance: string; error: string | null }
  | { step: 'working'; instance: string | null; message: string }
  | {
      step: 'browser-sign-in';
      instance: string;
      userCode: string;
      verificationUrl: string;
    }
  | { step: 'offline'; instance: string; error: string }
  | { step: 'instance' };

type Payload = { screen: Screen; accent: string | null };

const card = document.getElementById('card')!;
const root = document.documentElement.style;

function applyTokens(accent: string | null) {
  const light = tokens.light;
  root.setProperty('--ground', light.background);
  root.setProperty('--ink', light.foreground);
  root.setProperty('--card', light.card);
  root.setProperty('--muted', light['muted-foreground']);
  root.setProperty('--input', light.input);
  root.setProperty('--secondary', light.secondary);
  root.setProperty('--destructive', light.destructive);
  root.setProperty('--hairline', tokens.surfaces.hairline);
  root.setProperty('--hover', tokens.surfaces.hover);
  root.setProperty('--warm', tokens.ground.warm);
  root.setProperty('--fresh', tokens.ground.fresh);
  root.setProperty('--accent-tint', `${tokens.ground.accentTint}%`);
  root.setProperty('--shadow-window', tokens.shadows.window);
  root.setProperty('--radius-window', `${tokens.radius.window}px`);
  root.setProperty('--radius-md', `${tokens.radius.md}px`);
  root.setProperty('--radius-sm', `${tokens.radius.sm}px`);
  root.setProperty('--font-sans', `'${tokens.fonts.sans} Variable'`);
  root.setProperty('--font-mono', `'${tokens.fonts.mono}'`);
  root.setProperty('--weight-body', String(tokens.fontWeights.body));
  root.setProperty('--weight-strong', String(tokens.fontWeights.strong));
  root.setProperty('--weight-heading', String(tokens.fontWeights.heading));
  root.setProperty(
    '--accent',
    accent ??
      tokens.accents[tokens.defaultAccent as keyof typeof tokens.accents],
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & {
    dataset?: Record<string, string>;
  } = {},
  ...children: (Node | string | null)[]
) {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children.filter((child) => child !== null));
  return node;
}

function host(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' ? url.host : origin;
  } catch {
    return origin;
  }
}

function button(
  label: string,
  kind: 'primary' | 'secondary' | 'link',
  run: () => Promise<unknown> | unknown,
) {
  const node = el('button', {
    type: 'button',
    className: kind,
    textContent: label,
  });
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await run();
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

function header(title: string, lead: string | Node | null): Node[] {
  return [
    el('img', { className: 'logo', src: logo, alt: '', width: 56, height: 56 }),
    el('h1', { textContent: title }),
    ...(lead === null ? [] : [el('p', { className: 'lead' }, lead)]),
  ];
}

function errorNote(message: string | null) {
  return message
    ? el('p', { className: 'error', role: 'alert', textContent: message })
    : null;
}

function instanceChip(origin: string) {
  return el('span', { className: 'chip', textContent: host(origin) });
}

function render({ screen, accent }: Payload) {
  applyTokens(accent);
  card.dataset.step = screen.step;
  card.replaceChildren();
  switch (screen.step) {
    case 'connect': {
      const input = el('input', {
        type: 'text',
        name: 'address',
        placeholder: 'hatch.example.com',
        spellcheck: false,
        autocapitalize: 'off',
        required: true,
        value: screen.instance ? host(screen.instance) : '',
      });
      input.setAttribute('aria-label', 'Instance address');
      const submit = el('button', {
        type: 'submit',
        className: 'primary',
        textContent: 'Continue',
      });
      const form = el(
        'form',
        { className: 'stack' },
        el(
          'label',
          { className: 'field' },
          el('span', { textContent: 'Instance address' }),
          input,
        ),
        errorNote(screen.error),
        submit,
      );
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await invoke('connect', { address: input.value });
        } catch (error) {
          form.querySelector('.error')?.remove();
          submit.before(errorNote(String(error))!);
          submit.disabled = false;
        }
      });
      card.append(
        ...header(
          'Welcome to Hatch',
          'Enter the address of your Hatch instance to get started.',
        ),
        form,
      );
      queueMicrotask(() => input.focus());
      break;
    }
    case 'sign-in':
      card.append(
        ...header(
          'Sign in',
          el('span', {}, 'to ', instanceChip(screen.instance)),
        ),
        el(
          'div',
          { className: 'stack' },
          errorNote(screen.error),
          button('Sign in with browser', 'primary', () =>
            invoke('sign_in_with_browser'),
          ),
          el('p', {
            className: 'hint',
            textContent:
              'Your browser signs you in with your passkey, saved password or the session it already has, then brings you back here.',
          }),
          button('Use another instance', 'link', () =>
            invoke('change_instance'),
          ),
        ),
      );
      break;
    case 'browser-sign-in':
      card.append(
        ...header(
          'Continue in your browser',
          'Approve the request there. Check that it shows this code:',
        ),
        el('p', { className: 'code', textContent: screen.userCode }),
        el(
          'div',
          { className: 'stack' },
          el('p', {
            className: 'waiting',
            textContent: 'Waiting for approval…',
          }),
          button('Start a new request', 'secondary', () =>
            invoke('sign_in_with_browser'),
          ),
          button('Cancel', 'link', () => invoke('cancel_sign_in')),
        ),
      );
      break;
    case 'offline':
      card.append(
        ...header(
          "Can't reach your instance",
          el('span', {}, instanceChip(screen.instance)),
        ),
        el(
          'div',
          { className: 'stack' },
          errorNote(screen.error),
          button('Try again', 'primary', () => invoke('retry')),
          button('Open in browser', 'secondary', () =>
            invoke('open_instance_in_browser'),
          ),
          button('Use another instance', 'link', () =>
            invoke('change_instance'),
          ),
        ),
      );
      break;
    case 'working':
      card.append(
        ...header(
          screen.message || 'Opening Hatch…',
          screen.instance ? instanceChip(screen.instance) : null,
        ),
        el('div', { className: 'spinner', role: 'progressbar' }),
      );
      break;
    case 'instance':
      card.append(
        ...header('Opening Hatch…', null),
        el('div', { className: 'spinner', role: 'progressbar' }),
      );
      break;
  }
}

applyTokens(null);
render({
  screen: { step: 'working', instance: null, message: '' },
  accent: null,
});
void listen<Payload>('screen', (event) => render(event.payload));
void invoke<Payload>('get_screen').then(render);
