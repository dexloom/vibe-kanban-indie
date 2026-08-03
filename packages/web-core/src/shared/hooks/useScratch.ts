import { useCallback } from 'react';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { scratchApi } from '@/shared/lib/api';
import { ScratchType, type Scratch, type UpdateScratch } from 'shared/types';

type ScratchState = {
  scratch: Scratch | null;
};

export interface UseScratchResult {
  scratch: Scratch | null;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
  updateScratch: (update: UpdateScratch) => Promise<void>;
  deleteScratch: () => Promise<void>;
}

interface UseScratchOptions {
  /** Whether to enable the scratch connection. Defaults to true. */
  enabled?: boolean;
}

export const useScratch = (
  scratchType: ScratchType,
  id: string,
  options?: UseScratchOptions
): UseScratchResult => {
  const serverEnabled = (options?.enabled ?? true) && id.length > 0;
  const endpoint = serverEnabled
    ? scratchApi.getStreamUrl(scratchType, id)
    : undefined;

  const initialData = useCallback((): ScratchState => ({ scratch: null }), []);

  const { data, isConnected, isInitialized, error } =
    useJsonPatchWsStream<ScratchState>(endpoint, serverEnabled, initialData);

  const rawScratch = data?.scratch as (Scratch & { deleted?: boolean }) | null;
  const scratch = rawScratch?.deleted ? null : rawScratch;

  const updateScratch = useCallback(
    async (update: UpdateScratch) => {
      await scratchApi.update(scratchType, id, update);
    },
    [scratchType, id]
  );

  const deleteScratch = useCallback(async () => {
    await scratchApi.delete(scratchType, id);
  }, [scratchType, id]);

  const isLoading = !isInitialized && !error;

  return {
    scratch,
    isLoading,
    isConnected,
    error,
    updateScratch,
    deleteScratch,
  };
};
