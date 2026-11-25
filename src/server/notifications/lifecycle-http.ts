/** Shared HTTP handling of edit and recall requests after authentication. */
import {
  notificationRecallSchema,
  notificationUpdateSchema,
  pushIssueMessage,
} from './contract';
import {
  NotificationLifecycleError,
  recallNotification,
  updateNotification,
  type NotificationSender,
} from './lifecycle';

export type LifecycleAction = 'update' | 'recall';

export async function applyLifecycleRequest(
  sender: NotificationSender,
  action: LifecycleAction,
  json: unknown,
): Promise<Response> {
  try {
    if (action === 'update') {
      const update = notificationUpdateSchema.safeParse(json);
      if (!update.success) {
        return new Response(pushIssueMessage(update.error), { status: 400 });
      }
      return Response.json(await updateNotification(sender, update.data));
    }
    const recall = notificationRecallSchema.safeParse(json);
    if (!recall.success) {
      return new Response(
        recall.error.issues[0]?.message ?? 'Invalid request',
        { status: 400 },
      );
    }
    return Response.json(await recallNotification(sender, recall.data.id));
  } catch (error) {
    if (error instanceof NotificationLifecycleError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}
