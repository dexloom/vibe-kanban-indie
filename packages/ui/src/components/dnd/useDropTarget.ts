import { useMemo } from 'react';
import type { DragKind } from './types';

export type DropTargetDataAttrs = {
  'data-drop-target-id': string;
  'data-drop-target-project': string;
  'data-drop-target-accept-kinds': string;
  'data-drop-target-status'?: string;
  'data-drop-target-parent-id'?: string;
};

export interface UseDropTargetOptions {
  acceptKinds?: DragKind[];
  /** Status id the target card sits in. ONLY set on KanbanCard targets;
   * column targets (KanbanCards) leave it undefined so the controller
   * can distinguish card vs column via attribute presence. */
  statusId?: string;
  /** Parent project id of the target row (empty string = root). Project
   * reorder targets use this so the controller can scope collection to
   * siblings. */
  parentId?: string | null;
}

export function useDropTarget(
  targetId: string,
  projectId: string,
  options?: UseDropTargetOptions
): DropTargetDataAttrs {
  const acceptKinds = options?.acceptKinds ?? ['issue-move'];
  const serialized = acceptKinds.join(',');
  const statusId = options?.statusId;
  const parentId = options?.parentId;
  return useMemo(() => {
    const attrs: DropTargetDataAttrs = {
      'data-drop-target-id': targetId,
      'data-drop-target-project': projectId,
      'data-drop-target-accept-kinds': serialized,
    };
    if (statusId !== undefined) {
      attrs['data-drop-target-status'] = statusId;
    }
    if (parentId !== undefined) {
      attrs['data-drop-target-parent-id'] = parentId ?? '';
    }
    return attrs;
  }, [targetId, projectId, serialized, statusId, parentId]);
}
