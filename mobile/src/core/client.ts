import {
  createClient,
  ConnectError,
  Code,
  type Client,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import {
  AppService,
  AgentService,
  AuthService,
  WorkspaceService,
  NotificationService,
  PreferenceService,
  PublicErrorSchema,
  answersToMessages,
  type ReplyAnswers,
} from '@hatch/platform-api';
// The shared package's index does not re-export these two services yet.
import { PinService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/pin_pb';
import {
  ThemeService,
  type ResolvedTheme as ResolvedThemeMessage,
} from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/theme_pb';
import {
  isResolvedTheme,
  type ResolvedTheme,
} from '../../../packages/hatch-design-tokens/src';
import {
  appProjection,
  catalogProjection,
  notificationDetailProjection,
  notificationSummaryProjection,
  readStateProjection,
  sessionProjection,
  versionsPageProjection,
  summaryProjection,
} from './rpc-projections';
import {
  apiPath,
  boundedSignal,
  canonicalizeInstanceUrl,
  MobileError,
  pathId,
  throwIfAborted,
  validateHandoff,
} from './security';
import type { InstanceUrlOptions } from './security';
import { streamRunEvents } from './stream';
import type { StreamOptions, StreamResult } from './stream';
import type { InstanceVault } from './vault';
import type {
  AgentMessageMode,
  AppDetail,
  AppSummary,
  AskAnswer,
  Attachment,
  CreateRunInput,
  AgentModelCatalog,
  NotificationDetail,
  NotificationReadState,
  NotificationSummary,
  NotificationVersionsPage,
  PendingMessagesResult,
  Pins,
  PushDevice,
  PushRegistration,
  RunCreated,
  RunQueued,
  SessionDetail,
  SessionHandoff,
  SessionSummary,
} from './types';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type ClientOptions = InstanceUrlOptions & {
  origin: string;
  vault: InstanceVault;
  fetch: FetchLike;
  onUnauthorized?: (origin: string) => void;
};
type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
  authenticate?: boolean;
  timeoutMs?: number;
};

function statusError(status: number): MobileError {
  const message =
    status === 401
      ? 'Your session expired. Sign in to this instance again.'
      : status === 403
        ? 'This account does not have access.'
        : status === 404
          ? 'This item is no longer available.'
          : status === 409
            ? 'This request conflicts with the current session. Refresh and try again.'
            : status === 413
              ? 'This attachment or message is too large.'
              : status === 429
                ? 'The instance is busy. Try again shortly.'
                : status >= 500
                  ? 'The instance could not complete this request.'
                  : 'The instance rejected this request.';
  return new MobileError(
    status === 401 ? 'unauthorized' : 'request_failed',
    message,
    status,
  );
}

/** One client is permanently bound to one canonical origin. */

/** A resolved theme as the shared token package types it. */
export function resolvedTheme(message: ResolvedThemeMessage): ResolvedTheme {
  return {
    name: message.name,
    source: message.source === 'custom' ? 'custom' : 'preset',
    appearance: message.appearance === 'dark' ? 'dark' : 'light',
    colors: message.colors as ResolvedTheme['colors'],
    ramps: Object.fromEntries(
      Object.entries(message.ramps).map(([name, ramp]) => [name, ramp.shades]),
    ) as ResolvedTheme['ramps'],
    radius: message.radius as ResolvedTheme['radius'],
    fonts: message.fonts as ResolvedTheme['fonts'],
    shadows: message.shadows as ResolvedTheme['shadows'],
  };
}

export class HatchApiClient {
  readonly origin: string;
  readonly vault: InstanceVault;
  private readonly fetcher: FetchLike;
  private readonly appRpc: Client<typeof AppService>;
  private readonly agentRpc: Client<typeof AgentService>;
  private readonly authRpc: Client<typeof AuthService>;
  private readonly workspaceRpc: Client<typeof WorkspaceService>;
  private readonly notificationRpc: Client<typeof NotificationService>;
  private readonly preferenceRpc: Client<typeof PreferenceService>;
  private readonly pinRpc: Client<typeof PinService>;
  private readonly themeRpc: Client<typeof ThemeService>;
  private readonly onUnauthorized?: (origin: string) => void;
  constructor(options: ClientOptions) {
    this.origin = canonicalizeInstanceUrl(options.origin, options);
    this.vault = options.vault;
    this.fetcher = options.fetch;
    this.onUnauthorized = options.onUnauthorized;
    const transport = createConnectTransport({
      baseUrl: `${this.origin}/api/rpc`,
      useBinaryFormat: false,
      // Use the same credential snapshot, redirect, cookie and cache boundary as
      // native auth and Agent transport. Connect owns message encoding/decoding.
      fetch: (input, init) => {
        if (
          typeof input !== 'string' ||
          !input.startsWith(`${this.origin}/api/rpc/`) ||
          init?.method !== 'POST'
        )
          throw new MobileError('invalid_path', 'Invalid RPC destination.');
        return this.fetchResponse(input.slice(this.origin.length), {
          method: 'POST',
          headers: init.headers,
          body: init.body ?? undefined,
          signal: init.signal ?? undefined,
        });
      },
    });
    this.appRpc = createClient(AppService, transport);
    this.agentRpc = createClient(AgentService, transport);
    this.authRpc = createClient(AuthService, transport);
    this.workspaceRpc = createClient(WorkspaceService, transport);
    this.notificationRpc = createClient(NotificationService, transport);
    this.preferenceRpc = createClient(PreferenceService, transport);
    this.pinRpc = createClient(PinService, transport);
    this.themeRpc = createClient(ThemeService, transport);
  }

  private async fetchResponse(
    path: string,
    options: RequestOptions = {},
    credentialSnapshot?: string,
  ): Promise<Response> {
    const url = apiPath(this.origin, path);
    throwIfAborted(options.signal);
    const token =
      options.authenticate === false
        ? null
        : (credentialSnapshot ?? (await this.vault.get(this.origin)));
    throwIfAborted(options.signal);
    if (options.authenticate !== false && !token) throw statusError(401);
    const headers = new Headers(options.headers);
    headers.set('accept', headers.get('accept') ?? 'application/json');
    headers.set('cache-control', 'no-store');
    // Credentials never travel through URL query strings, cookies, or redirects.
    if (token) headers.set('authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: options.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throwIfAborted(options.signal);
      throw new MobileError(
        'network_error',
        'Could not reach this instance. Check your connection and its HTTPS address.',
      );
    }
    if (options.signal?.aborted) {
      // A late response can arrive after an aborted header race has returned.
      void response.body?.cancel().catch(() => undefined);
      throwIfAborted(options.signal);
    }
    // Defense in depth for test/custom transports that ignore redirect:'error'.
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== this.origin) ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new MobileError(
        'redirect_blocked',
        'The instance tried to redirect an API request.',
      );
    }
    if (
      response.status === 401 &&
      token &&
      (await this.vault.removeIfMatch(this.origin, token))
    ) {
      this.onUnauthorized?.(this.origin);
    }
    return response;
  }

  /** Includes an abortable timeout for the body, not just response headers. */
  request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithCredential(path, options);
  }

  private async requestWithCredential<T>(
    path: string,
    options: RequestOptions,
    credentialSnapshot?: string,
  ): Promise<T> {
    const bounded = boundedSignal(options.signal, options.timeoutMs ?? 30_000);
    try {
      const response = await this.fetchResponse(
        path,
        {
          ...options,
          signal: bounded.signal,
        },
        credentialSnapshot,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw statusError(response.status);
      }
      const value: unknown = await response.json();
      throwIfAborted(bounded.signal);
      if (typeof value !== 'object' || value === null) throw new Error();
      return value as T;
    } catch (error) {
      if (bounded.signal.aborted && !options.signal?.aborted) {
        throw new MobileError(
          'request_timeout',
          'The instance took too long to respond.',
        );
      }
      throwIfAborted(options.signal);
      if (error instanceof MobileError) throw error;
      throw new MobileError(
        'invalid_response',
        'The instance returned an invalid response.',
      );
    } finally {
      // Cancel the native request too: cancelling an unread Expo response body
      // alone does not stop the network task. Do this after error mapping so
      // cleanup cannot turn a server rejection into a timeout.
      bounded.abort();
      bounded.dispose();
    }
  }

  /** Login deliberately omits existing credentials and preserves OAuth errors. */
  async deviceRequest(
    path: '/api/auth/device/code' | '/api/auth/device/token',
    body: Record<string, string>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ status: number; ok: boolean; data: Record<string, unknown> }> {
    const bounded = boundedSignal(signal, timeoutMs);
    try {
      const response = await this.fetchResponse(path, {
        authenticate: false,
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        signal: bounded.signal,
      });
      const data: unknown = await response.json();
      throwIfAborted(bounded.signal);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new MobileError(
          'invalid_response',
          'The instance returned an invalid login response.',
        );
      }
      return {
        status: response.status,
        ok: response.ok,
        data: data as Record<string, unknown>,
      };
    } catch (error) {
      if (bounded.signal.aborted && !signal.aborted)
        throw new MobileError(
          'request_timeout',
          'The instance took too long to respond.',
        );
      throwIfAborted(signal);
      if (error instanceof MobileError) throw error;
      throw new MobileError(
        'invalid_response',
        'The instance returned an invalid login response.',
      );
    } finally {
      bounded.abort();
      bounded.dispose();
    }
  }

  private async rpcRequest<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const bounded = boundedSignal(signal, 30_000);
    try {
      throwIfAborted(bounded.signal);
      const result = await operation(bounded.signal);
      throwIfAborted(bounded.signal);
      return result;
    } catch (error) {
      if (bounded.signal.aborted && !signal?.aborted)
        throw new MobileError(
          'request_timeout',
          'The instance took too long to respond.',
        );
      throwIfAborted(signal);
      if (error instanceof MobileError) throw error;
      if (error instanceof ConnectError) {
        if (error.cause instanceof MobileError) throw error.cause;
        const detail = error.findDetails(PublicErrorSchema)[0];
        if (detail) throw statusError(detail.httpStatus);
        const statuses: Partial<Record<Code, number>> = {
          [Code.InvalidArgument]: 400,
          [Code.Unauthenticated]: 401,
          [Code.PermissionDenied]: 403,
          [Code.NotFound]: 404,
          [Code.Aborted]: 409,
          [Code.FailedPrecondition]: 409,
          [Code.ResourceExhausted]: 429,
          [Code.Unimplemented]: 501,
          [Code.Unavailable]: 503,
        };
        const status = statuses[error.code];
        if (status) throw statusError(status);
      }
      // Never show raw server/decoder text (which can contain private data).
      throw new MobileError(
        'invalid_response',
        'The instance returned an invalid response.',
      );
    } finally {
      bounded.dispose();
    }
  }

  async apps(signal?: AbortSignal): Promise<AppSummary[]> {
    const response = await this.rpcRequest(
      (signal) => this.appRpc.listApps({}, { signal }),
      signal,
    );
    return response.resources.map(appProjection);
  }
  workspace(signal?: AbortSignal) {
    return this.rpcRequest(
      (signal) => this.workspaceRpc.getWorkspace({}, { signal }),
      signal,
    );
  }
  /**
   * The signed-in user's theme (their active theme with their accent),
   * resolved by the platform into every token.
   */
  async theme(signal?: AbortSignal): Promise<ResolvedTheme> {
    const response = await this.rpcRequest(
      (signal) => this.themeRpc.getTheme({ resolve: true }, { signal }),
      signal,
    );
    const theme = response.resolved && resolvedTheme(response.resolved);
    if (!isResolvedTheme(theme))
      throw new MobileError(
        'invalid_response',
        'The instance returned no usable theme.',
      );
    return theme;
  }
  /** The user's pinned Apps, in the order every client shows them. */
  async pins(signal?: AbortSignal): Promise<Pins> {
    const response = await this.rpcRequest(
      (signal) => this.pinRpc.listPins({}, { signal }),
      signal,
    );
    return {
      apps: response.appPins.map((pin) => ({
        id: pin.id,
        appId: pin.appId,
        appSlug: pin.appSlug,
        label: pin.label,
        entryHash: pin.entryHash ?? '',
        appStatus: pin.appStatus,
      })),
    };
  }
  /** Pins an App at its root; an App already pinned keeps its pin. */
  pinApp(app: string, signal?: AbortSignal) {
    return this.rpcRequest(
      (signal) => this.pinRpc.pinApp({ app, ifAbsent: true }, { signal }),
      signal,
    ).then(() => undefined);
  }
  /** Removes one pin; other pins of the same App stay. */
  unpinApp(pinId: string, signal?: AbortSignal) {
    return this.rpcRequest(
      (signal) =>
        this.pinRpc.unpinApp(
          { target: { case: 'pinId', value: pinId } },
          { signal },
        ),
      signal,
    ).then(() => undefined);
  }
  setDashboardAutoRefresh(id: string, seconds: number, signal?: AbortSignal) {
    return this.rpcRequest(
      (signal) =>
        this.workspaceRpc.setDashboardAutoRefresh({ id, seconds }, { signal }),
      signal,
    );
  }
  async notifications(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ items: NotificationSummary[]; nextCursor: string | null }> {
    const result = await this.rpcRequest(
      (signal) =>
        // The timeline order: most recently pushed or edited first.
        this.notificationRpc.listNotifications(
          { cursor, limit: 50, order: 'activity' },
          { signal },
        ),
      signal,
    );
    return {
      items: result.notifications.map(notificationSummaryProjection),
      nextCursor: result.nextCursor ?? null,
    };
  }
  async notification(
    id: string,
    signal?: AbortSignal,
  ): Promise<NotificationDetail> {
    const result = await this.rpcRequest(
      (signal) => this.notificationRpc.getNotification({ id }, { signal }),
      signal,
    );
    if (!result.notification?.summary)
      throw new MobileError(
        'invalid_response',
        'The instance returned no notification.',
      );
    return notificationDetailProjection(result.notification);
  }
  /**
   * Answer a notification's reply form as the signed-in user. A notification
   * takes one answer per round; a later one, or one to a question an edit
   * has since replaced, fails with a conflict (409).
   */
  respondToNotification(
    id: string,
    round: number,
    answers: ReplyAnswers,
    signal?: AbortSignal,
  ) {
    return this.rpcRequest(
      (signal) =>
        this.notificationRpc.respondToNotification(
          { id, round, answers: answersToMessages(answers), via: 'mobile' },
          { signal },
        ),
      signal,
    ).then(() => undefined);
  }
  /** Earlier versions of a notification, newest first, a page at a time. */
  async notificationVersions(
    id: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<NotificationVersionsPage> {
    const result = await this.rpcRequest(
      (signal) =>
        this.notificationRpc.listNotificationRevisions(
          { id, cursor: cursor ?? '' },
          { signal },
        ),
      signal,
    );
    return versionsPageProjection(result);
  }
  /** How far this user has read the timeline, on every device. */
  async notificationReadState(
    signal?: AbortSignal,
  ): Promise<NotificationReadState> {
    const result = await this.rpcRequest(
      (signal) => this.notificationRpc.getNotificationReadState({}, { signal }),
      signal,
    );
    return readStateProjection(result.state);
  }
  /**
   * Mark the timeline read up to and including one notification, as of the
   * activity time it was shown with.
   */
  async markNotificationsRead(
    notificationId: string,
    activityAt: string,
    signal?: AbortSignal,
  ): Promise<NotificationReadState> {
    const result = await this.rpcRequest(
      (signal) =>
        this.notificationRpc.markNotificationsRead(
          {
            through: { case: 'notificationId', value: notificationId },
            activityAt,
          },
          { signal },
        ),
      signal,
    );
    return readStateProjection(result.state);
  }
  /** Delete a notification and its delivery history for the whole workspace. */
  deleteNotification(id: string, signal?: AbortSignal) {
    return this.rpcRequest(
      (signal) => this.notificationRpc.deleteNotification({ id }, { signal }),
      signal,
    ).then(() => undefined);
  }
  /** Bind this phone's APNs token and end-to-end key to the current session. */
  registerPushDevice(input: PushRegistration, signal?: AbortSignal) {
    return this.rpcRequest(
      (signal) =>
        this.notificationRpc.registerDevice(
          { ...input, platform: 'ios' },
          { signal },
        ),
      signal,
    ).then(() => undefined);
  }
  unregisterPushDevice(signal?: AbortSignal) {
    return this.rpcRequest(
      (signal) => this.notificationRpc.unregisterDevice({}, { signal }),
      signal,
    ).then(() => undefined);
  }
  async pushDevice(signal?: AbortSignal): Promise<PushDevice | null> {
    const result = await this.rpcRequest(
      (signal) => this.notificationRpc.getCurrentDevice({}, { signal }),
      signal,
    );
    const destination = result.destination;
    return destination
      ? {
          id: destination.id,
          name: destination.name,
          enabled: destination.enabled,
          lastError: destination.lastError ?? null,
        }
      : null;
  }
  /** Rename this phone's destination; registration never overwrites it. */
  renamePushDevice(id: string, name: string, signal?: AbortSignal) {
    return this.rpcRequest(
      (signal) =>
        this.notificationRpc.updateDestination({ id, name }, { signal }),
      signal,
    ).then(() => undefined);
  }
  async app(id: string, signal?: AbortSignal): Promise<AppDetail> {
    const response = await this.rpcRequest(
      (signal) => this.appRpc.getApp({ id }, { signal }),
      signal,
    );
    if (!response.resource)
      throw new MobileError(
        'invalid_response',
        'The instance returned no App.',
      );
    return appProjection(response.resource);
  }
  /**
   * An App's icon as an authenticated image request. `iconPath` is the
   * `icon_path` the instance returned for the App; anything that is not an
   * icon address on this instance yields null, and the App shows its monogram.
   * The credential travels in a header, never in the address.
   */
  async appIconSource(
    iconPath: string,
    size: 64 | 128 | 256,
  ): Promise<{ uri: string; headers: Record<string, string> } | null> {
    if (!/^\/api\/app\/[^/?#]+\/icon\?v=[A-Za-z0-9_-]+$/.test(iconPath))
      return null;
    const token = await this.vault.get(this.origin);
    if (!token) return null;
    return {
      uri: apiPath(this.origin, `${iconPath}&size=${size}`),
      headers: { authorization: `Bearer ${token}` },
    };
  }
  async sessions(
    appId?: string,
    signal?: AbortSignal,
  ): Promise<SessionSummary[]> {
    const response = await this.rpcRequest(
      (signal) => this.agentRpc.listSessions({ appId }, { signal }),
      signal,
    );
    return response.sessions.map(summaryProjection);
  }
  async session(id: string, signal?: AbortSignal): Promise<SessionDetail> {
    const response = await this.rpcRequest(
      (signal) => this.agentRpc.getSession({ id }, { signal }),
      signal,
    );
    if (!response.session)
      throw new MobileError(
        'invalid_response',
        'The instance returned no session.',
      );
    return sessionProjection(response.session);
  }
  async config(signal?: AbortSignal): Promise<AgentModelCatalog> {
    try {
      return catalogProjection(
        await this.rpcRequest(
          (signal) => this.agentRpc.getModelCatalog({}, { signal }),
          signal,
        ),
      );
    } catch (error) {
      if (
        error instanceof MobileError &&
        (error.status === 404 || error.status === 501)
      ) {
        throw new MobileError(
          'unsupported_api',
          'This instance does not provide the interactive Connect API. Update Hatch before connecting.',
        );
      }
      throw error;
    }
  }
  async createSession(
    input: {
      title?: string;
      providerId?: string;
      modelId?: string;
      thinkingLevel?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    const response = await this.rpcRequest(
      (signal) => this.agentRpc.createSession(input, { signal }),
      signal,
    );
    if (!response.id)
      throw new MobileError(
        'invalid_response',
        'The instance returned no session identity.',
      );
    return { id: response.id };
  }
  private post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal,
    });
  }
  createRun(
    input: Extract<CreateRunInput, { retry: true }>,
    signal?: AbortSignal,
  ): Promise<RunCreated>;
  createRun(
    input: CreateRunInput,
    signal?: AbortSignal,
  ): Promise<RunCreated | RunQueued>;
  async createRun(
    input: CreateRunInput,
    signal?: AbortSignal,
  ): Promise<RunCreated | RunQueued> {
    try {
      const result = await this.post<RunCreated | RunQueued>(
        '/api/agent/runs',
        input,
        signal,
      );
      // Only a resend that names its message can be already queued.
      if (
        'queued' in result &&
        result.queued === true &&
        'clientMessageId' in input &&
        input.clientMessageId
      )
        return { queued: true };
      if (
        !('runId' in result) ||
        typeof result.runId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(result.runId) ||
        typeof result.startedAt !== 'string' ||
        !Number.isFinite(Date.parse(result.startedAt))
      )
        throw new MobileError(
          'invalid_response',
          'The instance returned an invalid run identity.',
        );
      return result;
    } catch (error) {
      if (
        error instanceof MobileError &&
        [
          'network_error',
          'request_timeout',
          'cancelled',
          'invalid_response',
        ].includes(error.code)
      ) {
        throw new MobileError(
          'ambiguous_run',
          'The run may have started. Refresh this session before sending again.',
        );
      }
      throw error;
    }
  }
  /** Send a message while the run works, in the user's queue/steer mode. */
  async enqueuePending(
    sessionId: string,
    input: Omit<Extract<CreateRunInput, { content: unknown }>, 'sessionId'>,
    signal?: AbortSignal,
  ): Promise<PendingMessagesResult> {
    return this.pendingResult(
      await this.post(
        `/api/agent/sessions/${pathId(sessionId)}/pending`,
        input,
        signal,
      ),
    );
  }
  /** Replace a waiting message's text; its images and files stay. */
  async updatePendingText(
    sessionId: string,
    messageId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<PendingMessagesResult> {
    return this.pendingResult(
      await this.request(
        `/api/agent/sessions/${pathId(sessionId)}/pending/${pathId(messageId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ content: [{ type: 'text', text }] }),
          headers: { 'content-type': 'application/json' },
          signal,
        },
      ),
    );
  }
  async cancelPending(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<PendingMessagesResult> {
    return this.pendingResult(
      await this.request(
        `/api/agent/sessions/${pathId(sessionId)}/pending/${pathId(messageId)}`,
        { method: 'DELETE', signal },
      ),
    );
  }
  /** Stop the active run (its tools too) and start one with this message. */
  async sendPendingNow(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<PendingMessagesResult> {
    return this.pendingResult(
      await this.post(
        `/api/agent/sessions/${pathId(sessionId)}/pending/${pathId(messageId)}/send-now`,
        {},
        signal,
      ),
    );
  }
  async resumePending(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PendingMessagesResult> {
    return this.pendingResult(
      await this.post(
        `/api/agent/sessions/${pathId(sessionId)}/pending/resume`,
        {},
        signal,
      ),
    );
  }
  private pendingResult(value: unknown): PendingMessagesResult {
    const result = value as Partial<PendingMessagesResult> | null;
    if (
      !result ||
      typeof result !== 'object' ||
      !result.pending ||
      !Array.isArray(result.pending.messages) ||
      typeof result.pending.paused !== 'boolean' ||
      (result.startedRunId !== null && typeof result.startedRunId !== 'string')
    )
      throw new MobileError(
        'invalid_response',
        'The instance returned an invalid message list.',
      );
    return result as PendingMessagesResult;
  }
  /** Minutes a hidden App keeps running before it stops (Desk preference). */
  async backgroundAppMinutes(signal?: AbortSignal): Promise<number> {
    const response = await this.rpcRequest(
      (signal) => this.preferenceRpc.getDeskPreferences({}, { signal }),
      signal,
    );
    return response.preferences?.backgroundAppMinutes ?? 5;
  }
  async agentMessageMode(signal?: AbortSignal): Promise<AgentMessageMode> {
    const response = await this.rpcRequest(
      (signal) => this.preferenceRpc.getAgentPreferences({}, { signal }),
      signal,
    );
    return response.preferences?.messageMode === 'queue' ? 'queue' : 'steer';
  }
  async setAgentMessageMode(
    messageMode: AgentMessageMode,
    signal?: AbortSignal,
  ): Promise<AgentMessageMode> {
    const response = await this.rpcRequest(
      (signal) =>
        this.preferenceRpc.updateAgentPreferences({ messageMode }, { signal }),
      signal,
    );
    return response.preferences?.messageMode === 'queue' ? 'queue' : 'steer';
  }
  cancelRun(runId: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.post(`/api/agent/runs/${pathId(runId)}/cancel`, {}, signal);
  }
  answerRun(
    runId: string,
    askId: string,
    answers: AskAnswer[],
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }> {
    return this.post(
      `/api/agent/runs/${pathId(runId)}/answer`,
      { askId, answers },
      signal,
    );
  }
  async uploadAttachment(
    sessionId: string,
    attachmentId: string,
    body: BodyInit,
    filename: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<Attachment> {
    // Retry an upload only with the SAME attachmentId; a new ID creates a new object.
    return (
      await this.request<{ attachment: Attachment }>(
        `/api/agent/sessions/${pathId(sessionId)}/attachments/${pathId(attachmentId)}`,
        {
          method: 'PUT',
          body,
          headers: {
            'content-type': contentType,
            'x-attachment-name': encodeURIComponent(filename),
          },
          signal,
          timeoutMs: 120_000,
        },
      )
    ).attachment;
  }
  /** Sign a fresh WebView in with this session. It names no App or Dashboard. */
  /** The signed-in account's id; null for a credential that is not a user's session. */
  async accountId(signal?: AbortSignal): Promise<string | null> {
    const status = await this.rpcRequest(
      (signal) => this.authRpc.getStatus({}, { signal }),
      signal,
    );
    return status.credential.case === 'session'
      ? (status.credential.value.user?.id ?? null)
      : null;
  }

  async createHandoff(signal?: AbortSignal): Promise<SessionHandoff> {
    const result = await this.rpcRequest(
      (signal) => this.authRpc.createHandoff({}, { signal }),
      signal,
    );
    const handoff = {
      url: result.url,
      ticket: result.ticket,
      expiresAt: result.expiresAt,
      completionUrl: result.completionUrl,
    };
    validateHandoff(this.origin, handoff);
    return handoff;
  }
  async streamRun(
    runId: string,
    options: StreamOptions,
  ): Promise<StreamResult> {
    const after = options.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0)
      throw new MobileError('invalid_cursor', 'Invalid stream cursor.');
    const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
    if (!Number.isFinite(headerTimeoutMs) || headerTimeoutMs <= 0) {
      throw new MobileError(
        'invalid_timeout',
        'Stream connection timeout must be positive.',
      );
    }
    const connection = boundedSignal(options.signal, headerTimeoutMs);
    let onAbort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new MobileError('cancelled', 'Cancelled.'));
      connection.signal.addEventListener('abort', onAbort, { once: true });
      if (connection.signal.aborted) onAbort();
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchResponse(
            `/api/agent/runs/${pathId(runId)}/events?after=${after}`,
            {
              signal: connection.signal,
              headers: { accept: 'text/event-stream' },
            },
          ),
          interrupted,
        ]);
      } catch (error) {
        if (connection.signal.aborted) {
          throwIfAborted(options.signal);
          throw new MobileError(
            'stream_timeout',
            'The instance took too long to open the event stream. Reconnect to try again.',
          );
        }
        throw error;
      } finally {
        connection.signal.removeEventListener('abort', onAbort);
        connection.dispose();
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw statusError(response.status);
      }
      return await streamRunEvents(response, options);
    } finally {
      connection.abort();
    }
  }
  async signOut(signal?: AbortSignal): Promise<void> {
    // A failed server revocation is surfaced; the UI may offer explicit local-only forget.
    const token = await this.vault.get(this.origin);
    if (!token) return;
    try {
      await this.requestWithCredential(
        '/api/auth/sign-out',
        {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
          signal,
        },
        token,
      );
    } catch (error) {
      if (!(error instanceof MobileError && error.status === 401)) throw error;
    }
    await this.vault.removeIfMatch(this.origin, token);
  }
}
