/**
 * Native clients that sign in through the browser device approval
 * (`/cli/authorize`), and the name the approval page shows for each. The
 * server accepts exactly these `client_id`s; the page refuses any other.
 */
export const DEVICE_CLIENTS = {
  'hatch-cli': 'Hatch CLI',
  'hatch-mobile': 'Hatch Mobile',
  'hatch-desktop': 'Hatch for Mac',
} as const;

export type DeviceClientId = keyof typeof DEVICE_CLIENTS;

export function isDeviceClientId(value: unknown): value is DeviceClientId {
  return typeof value === 'string' && Object.hasOwn(DEVICE_CLIENTS, value);
}
