/**
 * The per-App part of a native App's generated NSH configuration, shared by
 * the platform build and the `hatch` CLI. The platform generates everything
 * else (grant, SDK aliases, theme, Tailwind extension, the entry tsconfig)
 * and delivers it with the SDK, so a checkout and a deploy check the App
 * against the same bytes; the CLI only adds the App's name, id and entry.
 */

/** Where the SDK delivers the generated configuration, below `.hatch/`. */
export const NATIVE_NSH_BASE_FILE = 'native/nsh.json';
export const NATIVE_ENTRY_TSCONFIG_FILE = 'native/app-tsconfig.json';

/** Written at the App root and beside the entry; never authored. */
export const NATIVE_GENERATED_FILES = ['nsh.json', 'app/tsconfig.json'];

/**
 * The NSH app id of a Hatch App: NSH scopes an App's storage by it, so the
 * mapping is reversible. Hatch ids are `[a-z0-9-]`; `x` and `-` are escaped
 * as `x` plus two hex digits (`habit-tracker` -> `habitx2dtracker`), so
 * `habit-tracker` and `habittracker` never share a namespace.
 */
export function nshAppId(appId: string): string {
  const encoded = appId.replace(
    /[^a-wyz0-9]/g,
    (char) => `x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
  return `dev.hatch.app.${encoded}`;
}

/** The root `nsh.json` of an App: its name, entry and id, then `base`. */
export function composeNativeNshJson(
  app: { id: string; name: string; entry: string },
  base: Record<string, unknown>,
): string {
  return `${JSON.stringify(
    {
      name: app.name,
      // Names the App root as NSH's app directory for this entry. Without
      // it, an `App.tsx` beside the entry would make `app/` the app
      // directory, where the SDK aliases under `.hatch/` cannot be reached.
      entry: app.entry,
      id: nshAppId(app.id),
      ...base,
    },
    null,
    2,
  )}\n`;
}
