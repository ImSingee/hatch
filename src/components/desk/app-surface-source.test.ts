import { describe, expect, it } from 'vitest';
import { appSurfaceFrameSource } from './app-surface-source';

describe('the address a surface loads an App from', () => {
  it('names macOS in the macOS app, so native Apps take its look', () => {
    expect(appSurfaceFrameSource('notes', true)).toBe(
      '/app/notes/embed/?platform=macos',
    );
  });

  it('names no platform in a browser', () => {
    expect(appSurfaceFrameSource('notes', false)).toBe('/app/notes/embed/');
  });
});
