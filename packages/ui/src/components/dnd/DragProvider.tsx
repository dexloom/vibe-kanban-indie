import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DragController, type DragControllerCallbacks } from './DragController';
import { DragControllerContext } from './DragContext';
import {
  DragActiveProvider,
  DragCandidateIndexProvider,
  DragCandidateProvider,
  DragSourceProjectProvider,
  DragSourceProvider,
} from '../outliner/dragState';
import type { Candidate, DragCompletion } from './types';

export interface DragProviderProps {
  onDrop: (completion: DragCompletion) => void;
  children: ReactNode;
}

export function DragProvider({ onDrop, children }: DragProviderProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [candidate, setCandidate] = useState<Candidate>({
    targetId: null,
    placement: null,
    index: null,
    isCard: false,
    sourceIssueId: null,
    sourceProjectId: null,
  });
  // `sourceIssueId` is constant for the duration of a drag — the
  // controller carries it on every candidate, but only the FIRST set
  // matters (subsequent identical values would still re-render the
  // source-context consumers). Guard with a setIfChanged so a noisy
  // rAF stream that re-emits the same id does not invalidate
  // `KanbanCard` instances across the source column.
  const [sourceIssueId, setSourceIssueId] = useState<string | null>(null);
  // `sourceProjectId` mirrors `sourceIssueId` for `project-reorder`
  // drags — project rows read it to dim themselves during a drag.
  const [sourceProjectId, setSourceProjectId] = useState<string | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const controllerRef = useRef<DragController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new DragController({
      onPromote: () => setIsDragActive(true),
      onDragEnd: () => {
        setIsDragActive(false);
        setSourceIssueId(null);
        setSourceProjectId(null);
      },
      onCandidateChange: (c: Candidate) => {
        setCandidate(c);
        if (c.sourceIssueId !== null) setSourceIssueId(c.sourceIssueId);
        if (c.sourceProjectId !== null) setSourceProjectId(c.sourceProjectId);
      },
      onDrop: (completion) => onDropRef.current(completion),
    } satisfies DragControllerCallbacks);
  }
  useEffect(() => {
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, []);
  // P4-E4: drop the `useMemo` that previously froze the controller
  // ref as the context value. Under StrictMode dev cleanup, the
  // effect nulls `controllerRef.current` but `useMemo` keeps serving
  // the destroyed controller. Serving the ref directly gives us a
  // fresh instance after the cleanup-and-recreate cycle. In
  // production the ref is stable across renders (it survives every
  // render except the post-cleanup re-create).
  return (
    <DragControllerContext.Provider value={controllerRef.current}>
      <DragActiveProvider value={isDragActive}>
        <DragSourceProvider value={sourceIssueId}>
          <DragSourceProjectProvider value={sourceProjectId}>
            <DragCandidateProvider value={candidate.targetId}>
              <DragCandidateIndexProvider value={candidate.index}>
                {children}
              </DragCandidateIndexProvider>
            </DragCandidateProvider>
          </DragSourceProjectProvider>
        </DragSourceProvider>
      </DragActiveProvider>
    </DragControllerContext.Provider>
  );
}
