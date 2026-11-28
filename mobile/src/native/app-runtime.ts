/**
 * The phone's native App runtime (`mobile/native`, through the thin Expo
 * module `modules/hatch-app-view`): one NSH engine per `native` App, owned
 * natively, so an App keeps running while its screen is gone. Without the
 * module (tests, a build without it) every call is a no-op and `available`
 * is false; `web` Apps never need it.
 */
import { requireOptionalNativeModule } from 'expo';
import type { ResolvedTheme } from '../../../packages/hatch-design-tokens/src';
import { buildAppTheme } from '../../../sdk-internal/ui/theme/build';

type Events = {
  /**
   * A running App asked to open another App (`hatch.nav.open`), on the
   * instance it runs for.
   */
  onOpenApp: (event: { slug: string; route: string; origin: string }) => void;
  /** The instance refused the session's credential to an App's request. */
  onUnauthorized: () => void;
};

type Subscription = { remove(): void };

type RuntimeModule = {
  configure(origin: string | null, token: string | null): Promise<void>;
  forgetStorage(origin: string): Promise<void>;
  setBackgroundMinutes(minutes: number): Promise<void>;
  setTheme(json: string | null): Promise<void>;
  navigate(appId: string, route: string): Promise<void>;
  reload(appId: string): Promise<void>;
  stop(appId: string): Promise<void>;
  handleBack(appId: string): Promise<boolean>;
  addListener<K extends keyof Events>(
    event: K,
    listener: Events[K],
  ): Subscription;
};

const runtime = requireOptionalNativeModule<RuntimeModule>('HatchAppView');

/** The NSH theme native Apps get for the user's resolved theme. */
export function nativeAppTheme(theme: ResolvedTheme): string {
  return JSON.stringify(buildAppTheme({ theme }));
}

const ignore = () => undefined;

export const appRuntime = {
  available: runtime !== null,
  /**
   * The signed-in instance; another instance, or none, stops every App.
   * Settles once the runtime has it: an App view mounted before then would
   * find no session.
   */
  async configure(origin: string | null, token: string | null) {
    await runtime?.configure(origin, token).catch(ignore);
  },
  /**
   * Deletes what Apps saved on this phone for `origin` once its account has
   * signed out, so the next account there finds none of it. Rejects when some
   * of it is still there: the runtime then keeps it from use until it is gone.
   */
  async forgetStorage(origin: string) {
    await runtime?.forgetStorage(origin);
  },
  setBackgroundMinutes(minutes: number) {
    void runtime?.setBackgroundMinutes(minutes).catch(ignore);
  },
  setTheme(theme: ResolvedTheme | null) {
    void runtime?.setTheme(theme ? nativeAppTheme(theme) : null).catch(ignore);
  },
  /** Asks a running App to show `route` (its own fragment, without `#`). */
  navigate(appId: string, route: string) {
    void runtime?.navigate(appId, route).catch(ignore);
  },
  reload(appId: string) {
    void runtime?.reload(appId).catch(ignore);
  },
  stop(appId: string) {
    void runtime?.stop(appId).catch(ignore);
  },
  /** The system back gesture: whether the App went back a page itself. */
  async handleBack(appId: string): Promise<boolean> {
    return (await runtime?.handleBack(appId).catch(() => false)) ?? false;
  },
  addListener<K extends keyof Events>(
    event: K,
    listener: Events[K],
  ): Subscription {
    return runtime?.addListener(event, listener) ?? { remove: ignore };
  },
};
