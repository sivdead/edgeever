import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserPreferences, UserPreferencesUpdate } from "@edgeever/shared";
import { api } from "@/lib/api";
import { readCachedUserPreferences, writeCachedUserPreferences } from "@/lib/user-preferences";

export const userPreferencesQueryKey = (userId: string | null | undefined) => ["me", "preferences", userId ?? null] as const;

export const useUserPreferences = (userId: string | null | undefined) => {
  const queryClient = useQueryClient();
  const queryKey = userPreferencesQueryKey(userId);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const { preferences } = await api.getUserPreferences();
      writeCachedUserPreferences(userId, preferences);
      return preferences;
    },
    enabled: Boolean(userId),
    // Picks up a change made on another device when the user comes back.
    refetchOnWindowFocus: true,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: (update: UserPreferencesUpdate) => api.updateUserPreferences(update),
    onMutate: async (update) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<UserPreferences>(queryKey) ?? readCachedUserPreferences(userId);
      const next = { ...previous, ...update };
      queryClient.setQueryData(queryKey, next);
      writeCachedUserPreferences(userId, next);
      return { previous };
    },
    onError: (_error, _update, context) => {
      if (!context) return;
      queryClient.setQueryData(queryKey, context.previous);
      writeCachedUserPreferences(userId, context.previous);
    },
    onSuccess: ({ preferences }) => {
      queryClient.setQueryData(queryKey, preferences);
      writeCachedUserPreferences(userId, preferences);
    },
  });

  return {
    preferences: query.data ?? readCachedUserPreferences(userId),
    updatePreferences: mutation.mutate,
    isUpdating: mutation.isPending,
    updateError: mutation.error,
  };
};
