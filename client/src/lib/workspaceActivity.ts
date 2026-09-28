import { createContext, useContext, useEffect, type DependencyList, type EffectCallback } from "react";
import { useQuery, type DefaultError, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";

/** Visibility of a retained workspace, independent of its frozen route. */
export const WorkspaceActivity = createContext(true);
export const useWorkspaceActive = () => useContext(WorkspaceActivity);

/** Only UI listeners/polling belong here; running AI and pending saves keep their lifecycle. */
export function useWorkspaceEffect(effect: EffectCallback, deps?: DependencyList): void {
  const active = useWorkspaceActive();
  useEffect(() => active ? effect() : undefined, deps ? [active, ...deps] : undefined);
}

export function useWorkspaceQuery<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
) {
  const active = useWorkspaceActive();
  return useQuery({
    ...options,
    enabled: active ? options.enabled : false,
    notifyOnChangeProps: active ? options.notifyOnChangeProps : [],
    refetchInterval: active ? options.refetchInterval : false,
  });
}
