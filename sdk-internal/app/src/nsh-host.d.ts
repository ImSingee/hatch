/**
 * The part of NSH's `nsh` module the native bridge uses. NSH supplies the
 * real module (and its full declarations) when it bundles and checks an App;
 * this declaration only lets the SDK build type-check against it. Public SDK
 * declarations never mention these types.
 */
declare module 'nsh' {
  export const host: {
    readonly params: Readonly<Record<string, unknown>>;
    call<T = unknown>(
      name: string,
      args?: unknown,
      options?: { timeout?: number },
    ): Promise<T>;
    post(name: string, data?: unknown): void;
    on(event: string, listener: (payload: unknown) => void): () => void;
    available(): boolean;
  };
  export function setTheme(theme: unknown): void;
}
