import { useMemo } from 'react';
import type { DragKind } from './types';

export type DropTargetDataAttrs = {
  'data-drop-target-id': string;
  'data-drop-target-project': string;
  'data-drop-target-accept-kinds': string;
};

export interface UseDropTargetOptions {
  acceptKinds?: DragKind[];
}

export function useDropTarget(
  targetId: string,
  projectId: string,
  options?: UseDropTargetOptions
): DropTargetDataAttrs {
  const acceptKinds = options?.acceptKinds ?? ['issue-move'];
  const serialized = acceptKinds.join(',');
  return useMemo(
    () => ({
      'data-drop-target-id': targetId,
      'data-drop-target-project': projectId,
      'data-drop-target-accept-kinds': serialized,
    }),
    [targetId, projectId, serialized]
  );
}
