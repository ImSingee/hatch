import { describe, expect, it } from 'vitest';
import { checkCatalogs, type Catalog } from './catalog-check';

const en = {
  'nav.home': 'Home',
  'product.name': 'Tailscale',
  greeting: 'Hello {{name}}, {{count, number}} new',
};
const zh = {
  'nav.home': '首页',
  'product.name': 'Tailscale',
  greeting: '你好 {{name}}，{{count, number}} 条新消息',
};

function check(
  zhCatalog: Catalog | undefined,
  sameAsSource: readonly string[] = ['product.name'],
) {
  return checkCatalogs({
    sourceLocale: 'en',
    locales: ['en', 'zh-CN'],
    catalogs: { en, 'zh-CN': zhCatalog },
    sameAsSource: { 'zh-CN': sameAsSource },
  });
}

describe('translation gate', () => {
  it('accepts complete catalogs', () => {
    expect(check(zh)).toEqual([]);
  });

  it('rejects a key added only to the source catalog', () => {
    const { 'nav.home': _, ...missing } = zh;
    expect(check(missing)).toEqual(['zh-CN: "nav.home" has no translation.']);
  });

  it('rejects a key that copies the source text unless it is listed', () => {
    expect(check({ ...zh, 'nav.home': 'Home' })).toEqual([
      expect.stringMatching(/^zh-CN: "nav\.home" is still the en text/),
    ]);
    expect(check(zh, [])).toEqual([
      expect.stringMatching(/^zh-CN: "product\.name" is still the en text/),
    ]);
  });

  it('rejects empty, extra and mismatched-placeholder entries', () => {
    expect(
      check({
        ...zh,
        'nav.home': ' ',
        greeting: '你好 {{user}}，{{count}} 条新消息',
        'nav.removed': '旧的',
      }),
    ).toEqual([
      'zh-CN: "nav.home" is empty.',
      'zh-CN: "greeting" uses ["{{count}}","{{user}}"] but en uses ["{{count}}","{{name}}"].',
      expect.stringMatching(/^zh-CN: "nav\.removed" is not in the en catalog/),
    ]);
  });

  it('rejects stale same-as-source entries and missing catalogs', () => {
    expect(check(zh, ['product.name', 'nav.home', 'gone'])).toEqual([
      expect.stringMatching(/same-as-source key "nav\.home" is translated/),
      'zh-CN: same-as-source key "gone" does not exist.',
    ]);
    expect(check(undefined)).toEqual(['zh-CN: the catalog is missing.']);
  });
});
