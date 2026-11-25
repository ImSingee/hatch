/**
 * Stand-in for the `nsh` module, which only the NSH runtime provides (it is
 * not an npm package). Unit tests of `@hatch/app/native` resolve `nsh` here
 * and mock it with `vi.mock('nsh', ...)`.
 */
export const host = {
  call: (): Promise<never> =>
    Promise.reject(new Error('No NSH host in this test.')),
  on: (): (() => void) => () => {},
};

export function setTheme(): void {}
