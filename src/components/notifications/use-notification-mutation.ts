import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useErrorText } from '~i18n';
import { NOTIFICATIONS_KEY } from '~queries/notifications';

/**
 * Mutation that refreshes every notification query afterwards (also on
 * failure, since a 404/409 means the configuration changed underneath us).
 * Errors are toasted here, translated by their stable code.
 */
export function useNotificationMutation<TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
  options: {
    success?: string | ((result: TResult) => string | null);
    onSuccess?: (result: TResult, input: TInput) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  return useMutation({
    mutationFn,
    meta: { errorToast: false },
    onError: (error) => {
      toast.error(errorText(error, 'notifications.error.actionFailed'));
    },
    onSuccess: (result, input) => {
      const message =
        typeof options.success === 'function'
          ? options.success(result)
          : options.success;
      if (message) toast.success(message);
      options.onSuccess?.(result, input);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}
