export type DragKind = 'issue-move' | 'column-reorder' | 'project-reorder';

export type DragSource = {
  kind: 'issue-move';
  issueId: string;
  projectId: string;
};

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
  /** Id of the dragged issue (issue-move only), so consumers can account
   * for the source card's presence in the target column. Constant within a
   * drag. */
  sourceIssueId: string | null;
}
