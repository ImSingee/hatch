import { createServerFn } from '@tanstack/react-start';
import {
  tailscaleConfigureSchema,
  type TailscaleConfigureInput,
} from '../tailscale';
import { authMiddleware } from './auth';
import { AppError } from './errors';
import { getTailscaleManager } from './tailscale-manager';

export const getTailscaleStatus = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    return getTailscaleManager().getStatus();
  });

export const configureTailscale = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: TailscaleConfigureInput) => {
    const result = tailscaleConfigureSchema.safeParse(input);
    if (!result.success)
      throw new AppError('Invalid Tailscale connection settings.', 400, {
        code: 'tailscale.invalidSettings',
      });
    return result.data;
  })
  .handler(async ({ data }) => {
    return getTailscaleManager().configure(data);
  });
