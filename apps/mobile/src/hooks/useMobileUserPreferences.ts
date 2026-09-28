import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { createEdgeEverClient } from "@edgeever/client";
import { DEFAULT_USER_PREFERENCES, type UserPreferences, type UserPreferencesUpdate } from "@edgeever/shared";
import { readCachedMobileUserPreferences, writeCachedMobileUserPreferences } from "../lib/user-preferences";

type MobileClient = ReturnType<typeof createEdgeEverClient>;

export const useMobileUserPreferences = ({ client, dataScope }: { client: MobileClient | null; dataScope: string }) => {
  const queryClient = useQueryClient();
  const remoteKey = ["mobile", "user-preferences", dataScope] as const;
  const cachedQuery = useQuery({
    queryKey: ["mobile", "user-preferences-cache", dataScope],
    queryFn: () => readCachedMobileUserPreferences(dataScope),
    staleTime: Infinity,
  });
  const remoteQuery = useQuery({
    queryKey: remoteKey,
    queryFn: async () => {
      const { preferences } = await client!.getUserPreferences();
      await writeCachedMobileUserPreferences(dataScope, preferences);
      return preferences;
    },
    enabled: Boolean(client),
    retry: false,
  });
  const { refetch } = remoteQuery;

  // Picks up a change made on another device when the app comes back.
  useEffect(() => {
    if (!client) return;
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") void refetch();
    });
    return () => subscription.remove();
  }, [client, refetch]);

  const mutation = useMutation({
    mutationFn: (update: UserPreferencesUpdate) => {
      if (!client) throw new Error("Client is not ready");
      return client.updateUserPreferences(update);
    },
    onMutate: async (update) => {
      await queryClient.cancelQueries({ queryKey: remoteKey });
      const previous = queryClient.getQueryData<UserPreferences>(remoteKey) ?? cachedQuery.data ?? { ...DEFAULT_USER_PREFERENCES };
      queryClient.setQueryData(remoteKey, { ...previous, ...update });
      return { previous };
    },
    onError: (_error, _update, context) => {
      if (context) queryClient.setQueryData(remoteKey, context.previous);
    },
    onSuccess: async ({ preferences }) => {
      queryClient.setQueryData(remoteKey, preferences);
      await writeCachedMobileUserPreferences(dataScope, preferences);
    },
  });

  return {
    preferences: remoteQuery.data ?? cachedQuery.data ?? DEFAULT_USER_PREFERENCES,
    // Lists wait for the cached copy so they do not flash the wrong scope.
    isReady: remoteQuery.data !== undefined || cachedQuery.isFetched,
    updatePreferences: mutation.mutate,
    isUpdating: mutation.isPending,
    updateError: mutation.error,
  };
};
