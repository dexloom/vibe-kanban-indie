import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DragController, type DragControllerCallbacks } from './DragController';
import { DragControllerContext } from './DragContext';
import {
  DragActiveProvider,
  DragCandidateProvider,
  DragInsertionProvider,
  type InsertionPoint,
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
    sourceIssueId: null,
  });
  const [insertion, setInsertion] = useState<InsertionPoint | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const controllerRef = useRef<DragController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new DragController({
      onPromote: () => setIsDragActive(true),
      onDragEnd: () => {
        setIsDragActive(false);
        setInsertion(null);
      },
      onCandidateChange: (c: Candidate) => {
        setCandidate(c);
        setInsertion(
          c.targetId && c.index !== null
            ? {
                targetId: c.targetId,
                index: c.index,
                sourceIssueId: c.sourceIssueId,
              }
            : null,
        );
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
  const value = useMemo(() => ({ controller: controllerRef.current }), []);
  return (
    <DragControllerContext.Provider value={value}>
      <DragActiveProvider value={isDragActive}>
        <DragCandidateProvider value={candidate.targetId}>
          <DragInsertionProvider value={insertion}>
            {children}
          </DragInsertionProvider>
        </DragCandidateProvider>
      </DragActiveProvider>
    </DragControllerContext.Provider>
  );
}
