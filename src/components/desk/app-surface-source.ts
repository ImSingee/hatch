import { isDesktopHost } from '~components/desktop-host/host';

/**
 * Where an App's frontend is served. Human-facing routes use the mutable
 * slug; immutable ids stay in technical API paths.
 */
export function appSurfaceSource(slug: string) {
  return `/app/${slug}/embed/`;
}

/**
 * What a surface loads an App from. In the macOS app (its `HatchDesktop`
 * user agent token) the surface names the platform, as the Mobile app's
 * WebView does (`?platform=`), so a native App's components take macOS's
 * look; a browser names none and keeps the web's. A `web` App ignores the
 * query.
 */
export function appSurfaceFrameSource(slug: string, macApp = isDesktopHost()) {
  const source = appSurfaceSource(slug);
  return macApp ? `${source}?platform=macos` : source;
}
