/**
 * How long a minimised App keeps running in the background before the Desk
 * stops it (it then reopens on the page it was left on). A personal
 * preference of each user: Settings › Account, `hatch preferences`.
 */
export const DEFAULT_BACKGROUND_APP_MINUTES = 5;
export const MIN_BACKGROUND_APP_MINUTES = 1;
export const MAX_BACKGROUND_APP_MINUTES = 1440;

export function isBackgroundAppMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_BACKGROUND_APP_MINUTES &&
    value <= MAX_BACKGROUND_APP_MINUTES
  );
}
