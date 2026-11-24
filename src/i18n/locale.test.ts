import { describe, expect, it } from 'vitest';
import { detectLocale } from './locale';

describe('detectLocale', () => {
  it('keeps a saved choice over the browser preference', () => {
    expect(detectLocale('en', ['zh-CN'])).toBe('en');
    expect(detectLocale('zh-CN', ['en-US'])).toBe('zh-CN');
  });

  it('maps any Chinese browser preference to Simplified Chinese', () => {
    for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-Hant-HK']) {
      expect(detectLocale(null, [language])).toBe('zh-CN');
    }
  });

  it('falls back to English for other or unusable preferences', () => {
    expect(detectLocale('fr', ['ja-JP'])).toBe('en');
    expect(detectLocale(null, [])).toBe('en');
    expect(detectLocale(null, ['not a locale!'])).toBe('en');
  });
});
