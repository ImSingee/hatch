/**
 * Server-only: the error a rejected theme document raises. Kept apart from
 * `theme-settings.ts` so the public API error mapping can name it without
 * loading the database.
 */
import type { ThemeProblem } from '../../packages/hatch-design-tokens/src';
import { AppError } from '~server/errors';

/** A theme document the platform refused, with every reason. */
export class ThemeValidationError extends AppError {
  constructor(readonly problems: ThemeProblem[]) {
    super(
      [
        'The theme was rejected:',
        ...problems.map((problem) => `- ${problem.message}`),
      ].join('\n'),
      400,
      { code: 'theme_invalid' },
    );
    this.name = 'ThemeValidationError';
  }
}
