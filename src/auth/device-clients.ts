/**
 * Native clients that sign in through the browser device approval
 * (`/cli/authorize`). The server accepts exactly these `client_id`s; the
 * approval page refuses any other.
 *
 * - `name`: what the approval page calls the client.
 * - `returnUrl`: where the page sends the browser once the request is
 *   approved, to bring an app installed on the same computer back to the
 *   front. It only switches apps: the app receives its session through its
 *   own polling, never through this link.
 */
export const DEVICE_CLIENTS = {
  'hatch-cli': { name: 'Hatch CLI', returnUrl: null },
  'hatch-mobile': { name: 'Hatch Mobile', returnUrl: null },
  'hatch-desktop': { name: 'Hatch for Mac', returnUrl: 'hatch://' },
} as const satisfies Record<string, { name: string; returnUrl: string | null }>;

export type DeviceClientId = keyof typeof DEVICE_CLIENTS;

export function isDeviceClientId(value: unknown): value is DeviceClientId {
  return typeof value === 'string' && Object.hasOwn(DEVICE_CLIENTS, value);
}
