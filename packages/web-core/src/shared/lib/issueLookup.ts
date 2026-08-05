export interface IssueDragLookupRow {
  id: string;
  project_id: string;
  status_id: string;
  sort_order: number;
}

export function buildIssueDragLookup(
  issues: readonly {
    id: string;
    project_id: string;
    status_id: string;
    sort_order: number;
  }[],
  activeProjectId: string
): Map<string, IssueDragLookupRow> {
  const byId = new Map<string, IssueDragLookupRow>();
  for (const issue of issues) {
    if (issue.project_id !== activeProjectId) continue;
    byId.set(issue.id, {
      id: issue.id,
      project_id: issue.project_id,
      status_id: issue.status_id,
      sort_order: issue.sort_order,
    });
  }
  return byId;
}
