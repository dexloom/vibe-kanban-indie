export type DragKind = 'issue-move' | 'column-reorder' | 'project-reorder';

/** Discriminated union — future `column-reorder` / `project-reorder` variants
 * extend this; consumers narrow via `source.kind`. */
export type DragSource =
  | {
      kind: 'issue-move';
      issueId: string;
      projectId: string;
      statusId: string;
    }
  | { kind: 'project-reorder'; projectId: string; parentId: string | null };

export type Placement = 'on' | 'before' | 'after';

export interface DragCompletion {
  source: DragSource;
  targetId: string;
  placement: Placement;
  /** Index = card insertion slot, non-null only for issue-move onto a kanban column; orthogonal to Placement which serves future reorder kinds. */
  index: number | null;
}

export interface Candidate {
  targetId: string | null;
  placement: Placement | null;
  /** Index = card insertion slot, non-null only for issue-move onto a kanban column; orthogonal to Placement which serves future reorder kinds. */
  index: number | null;
  /** True when the winning target is a kanban CARD (same-column swap target).
   * Drives the card-candidate freeze in the controller. */
  isCard: boolean;
  /** Id of the dragged issue (issue-move only), so consumers can account
   * for the source card's presence in the target column. Constant within a
   * drag. */
  sourceIssueId: string | null;
  /** Id of the dragged project (project-reorder only); constant within a
   * drag. */
  sourceProjectId: string | null;
}
