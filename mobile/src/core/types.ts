/** UI projections derive from shared RPC descriptors; Agent SSE keeps its own contract. */
import type {
  Resource,
  AgentModel,
  AgentProvider,
  AgentModelSelection,
  AgentQuestion,
  AgentPendingAsk,
  AgentPendingEnvironment,
  AgentSessionSummary as RpcSessionSummary,
  ReplyAnswers,
  ReplyForm,
} from '@hatch/platform-api';
import type { NotificationCard } from '../../../packages/hatch-platform-api/notification-card';

/** Remove Protobuf runtime metadata without duplicating the shared contract. */
type Plain<T> = T extends (infer Item)[]
  ? Plain<Item>[]
  : T extends object
    ? {
        [Key in keyof T as Key extends `$${string}` ? never : Key]: Plain<
          T[Key]
        >;
      }
    : T;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AppSummary = Omit<Plain<Resource>, 'description' | 'iconPath'> & {
  description: string | null;
  /** Apps only: where the icon PNG is served; null while it shows a monogram. */
  iconPath: string | null;
  /**
   * Has a successful deployment to open. An App whose first deployment is
   * still building or failed has none, whatever its status says.
   */
  live: boolean;
};
export type AppDetail = AppSummary;
export type Model = Plain<AgentModel>;
export type AgentModelCatalog = {
  providers: Plain<AgentProvider>[];
  defaultModel: Plain<AgentModelSelection> | null;
};
export type AskQuestion = Plain<AgentQuestion>;
export type AskAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  customText?: string;
};
export type PendingAsk = Plain<AgentPendingAsk>;
export type PendingEnv = Plain<AgentPendingEnvironment>;
export type RunStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type ActiveRun = {
  id: string;
  status: RunStatus;
  startedAt: string;
  userTurn: number | null;
  pendingAsk: PendingAsk | null;
  answeredAskId?: string | null;
  pendingEnvRequest: PendingEnv | null;
};
export type SessionSummary = Omit<
  Plain<RpcSessionSummary>,
  'providerId' | 'modelId'
> & {
  providerId: string | null;
  modelId: string | null;
};
export type AgentMessageMode = 'queue' | 'steer';
/** A message sent while the Agent worked, not delivered yet. */
export type PendingMessage = {
  id: string;
  mode: AgentMessageMode;
  /** `pending` is editable; `claimed` and `sending` are being delivered. */
  status: 'pending' | 'claimed' | 'sending';
  /** Composer parts; the app edits only plain text messages. */
  content: JsonValue[];
  text: string;
  images: { data: string; mimeType: string }[];
  attachments: Attachment[];
  providerId: string;
  modelId: string;
};
export type PendingMessages = { paused: boolean; messages: PendingMessage[] };
export type PendingMessagesResult = {
  pending: PendingMessages;
  startedRunId: string | null;
};
export type SessionDetail = Omit<SessionSummary, 'messageCount'> & {
  messages: JsonValue[];
  pending: PendingMessages;
  activeRun: ActiveRun | null;
  runs: {
    id: string;
    status: RunStatus;
    userTurn: number;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
  }[];
  serverTime: string;
};
export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};
export type CreateRunInput = {
  sessionId: string;
  providerId: string;
  modelId: string;
} & (
  | {
      retry?: false;
      content: { type: 'text'; text: string }[];
      images?: { data: string; mimeType: string }[];
      attachmentIds?: string[];
      /** Reused when resending the same draft; the server dedupes on it. */
      clientMessageId?: string;
    }
  | { retry: true; expectedSessionUpdatedAt: string }
);
export type RunCreated = { runId: string; startedAt: string };
/**
 * A message resent after a lost response that the earlier send already put
 * in the pending tray, where it still waits: accepted, and no run started.
 */
export type RunQueued = { queued: true };
/** Resource-free browser sign-in; the client chooses where to go afterwards. */
export type SessionHandoff = {
  url: string;
  ticket: string;
  expiresAt: string;
  completionUrl: string;
};

export type AgentStreamEvent =
  | { type: 'assistant_start' }
  | { type: 'text' | 'thinking'; delta: string }
  | ({ type: 'ask' } & PendingAsk)
  | { type: 'ask_answered'; askId: string }
  | ({ type: 'env_request' } & PendingEnv)
  | {
      type: 'env_stored';
      requestId: string;
      variables: { key: string; secret: boolean }[];
    }
  | {
      type: 'tool_start';
      id: string;
      name: string;
      label?: string;
      args: JsonValue;
      details?: JsonValue;
    }
  | { type: 'tool_update'; id: string; name: string; output: string }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      isError: boolean;
      output?: string;
      details?: JsonValue;
      summary?: string;
    }
  | { type: 'turn_end' | 'cancelled' }
  | {
      /** A steer message the run took in while working. */
      type: 'user_message';
      pendingId: string;
      text: string;
      /** Image metadata only; the data is known from the pending tray. */
      images?: { mimeType: string }[];
      attachments?: Attachment[];
    }
  | {
      /** Auto-compaction lifecycle, shown as a step of the live reply. */
      type: 'compact';
      reason: 'threshold' | 'overflow';
      phase: 'start' | 'done' | 'failed';
      tokensBefore?: number;
      tokensAfter?: number;
    }
  // `stopReason` is set when the completed reply did not end on a clean
  // `stop` — the model ended it early, e.g. `length` at its output limit.
  | { type: 'done'; stopReason?: string }
  | { type: 'error'; message: string };
export type RunStreamEvent = { seq: number; event: AgentStreamEvent };

export type NotificationSummary = {
  id: string;
  sourceType: string;
  /** The App, Channel or sending user; null for the platform. */
  sourceId: string | null;
  sourceName: string;
  kind: string;
  kindName: string;
  title: string;
  body: string | null;
  url: string | null;
  occurredAt: string;
  status: string;
  /** -2 lowest (not pushed to phones), -1 low, 0 normal, 1 high. */
  priority: number;
  /** Set when the source edited the notification. */
  editedAt: string | null;
  /** 1 for the original; every edit and the recall increment it. */
  revision: number;
  /** Versions an edit replaced; 0 when never edited. */
  earlierVersions: number;
  /** Set when the source recalled it; phones no longer show it. */
  recalledAt: string | null;
  /** The question it asks now; each round takes one answer. */
  reply: ReplyForm | null;
  replyRound: number;
  respondedAt: string | null;
  /** The answer to the current round, once given. */
  response: NotificationAnswer | null;
  /** When its source last pushed or edited it: the timeline order. */
  activityAt: string;
  /** Status and one block the timeline shows. */
  card: NotificationCard | null;
};
/** The answer to one round of a notification's reply form. */
/** A version an edit replaced, kept in the notification's history. */
export type NotificationVersion = {
  revision: number;
  title: string;
  body: string | null;
  url: string | null;
  card: NotificationCard | null;
  reply: ReplyForm | null;
  replyRound: number;
  /** When it became current, and when an edit replaced it. */
  activityAt: string;
  replacedAt: string;
};
/** One page of earlier versions, newest first, with their rounds' answers. */
export type NotificationVersionsPage = {
  versions: NotificationVersion[];
  answers: NotificationAnswer[];
  nextCursor: string | null;
};
export type NotificationAnswer = {
  round: number;
  respondedByUserId: string | null;
  answers: ReplyAnswers;
  respondedByName: string;
  /** push | mobile | web | cli */
  via: string;
  respondedAt: string;
};
export type NotificationDelivery = {
  id: string;
  destinationType: string;
  destinationName: string;
  status: string;
  attempts: number;
  lastError: string | null;
  result: string | null;
  completedAt: string | null;
};
export type NotificationDetail = NotificationSummary & {
  deliveries: NotificationDelivery[];
  response: NotificationAnswer | null;
};
/** This phone's destination on the connected instance. */
export type PushDevice = {
  id: string;
  name: string;
  enabled: boolean;
  lastError: string | null;
};

export type PushRegistration = {
  name: string;
  apnsToken: string;
  apnsEnvironment: 'sandbox' | 'production';
  e2eKeyId: string;
  e2eKey: string;
};

/** One pin of an App: its own label and destination, even for the same App. */
export type AppPin = {
  id: string;
  appId: string;
  appSlug: string;
  label: string;
  /** The App's own route without `#`; empty opens the App root. */
  entryHash: string;
  appStatus: string;
};
export type Pins = {
  apps: AppPin[];
};

/** How far this user has read the notification timeline, on every device. */
export type NotificationReadState = {
  readThroughId: string | null;
  unreadCount: number;
  firstUnreadId: string | null;
};
