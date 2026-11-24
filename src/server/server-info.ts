/** Server Function for the running server's build (Web UI). */
import { createServerFn } from '@tanstack/react-start';
import { buildInfo } from '~/build-info';
import { authMiddleware } from './auth';

/**
 * Read on the server, so it names the build that is running now even when
 * the open page was loaded from an earlier one.
 */
export const getServerInfoFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => buildInfo);
