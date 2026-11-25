import type { ReplyAnswers } from '@hatch/platform-api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { MobileError } from '../core';
import { errorText } from '../ui/primitives';
import { useSession } from './session';

/**
 * Answers a notification's reply form, from its detail or from a card in
 * the timeline: the same round, the same RPC.
 */
export function useRespondToNotification(id: string) {
  const { api, origin } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    // The round on screen, so a question an edit replaced meanwhile is
    // refused rather than answered with this form.
    mutationFn: (input: { round: number; answers: ReplyAnswers }) =>
      api!.respondToNotification(id, input.round, input.answers),
    onError: (error) =>
      Alert.alert(
        'Answer not sent',
        error instanceof MobileError && error.status === 409
          ? 'Someone already answered, the sender recalled it, or it now asks something else.'
          : errorText(error),
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [origin, 'notification', id],
        }),
        queryClient.invalidateQueries({ queryKey: [origin, 'notifications'] }),
      ]),
  });
}
