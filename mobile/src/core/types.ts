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

export type AppSummary = Omit<Plain<Resource>, 'description'> & {
  description: string | null;
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
export type SessionDetail = Omit<SessionSummary, 'messageCount'> & {
  messages: JsonValue[];
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
    }
  | { retry: true; expectedSessionUpdatedAt: string }
);
export type RunCreated = { runId: string; startedAt: string };
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
  | { type: 'turn_end' | 'cancelled' | 'done' }
  | { type: 'error'; message: string };
export type RunStreamEvent = { seq: number; event: AgentStreamEvent };

export type NotificationSummary = {
  id: string;
  sourceType: string;
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
  /** Set when the source recalled it; phones no longer show it. */
  recalledAt: string | null;
  /** Form the notification asks people to answer once. */
  reply: ReplyForm | null;
  respondedAt: string | null;
};
/** The one answer to a notification's reply form. */
export type NotificationAnswer = {
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
