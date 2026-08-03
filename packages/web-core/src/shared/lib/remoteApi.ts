import type {
  UpdateIssueRequest,
  UpdateProjectRequest,
  UpdateProjectStatusRequest,
} from 'shared/remote-types';

const REMOTE_API_BASE = '';

export const makeRequest = async (
  path: string,
  options: RequestInit = {},
  _retryOn401 = true
): Promise<Response> => {
  return makeAuthenticatedRequest(REMOTE_API_BASE, path, options);
};

async function makeAuthenticatedRequest(
  baseUrl: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('X-Client-Version', __APP_VERSION__);
  headers.set('X-Client-Type', 'frontend');

  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });
}

export interface BulkUpdateIssueItem {
  id: string;
  changes: Partial<UpdateIssueRequest>;
}

export interface BulkUpdateProjectItem {
  id: string;
  changes: Partial<UpdateProjectRequest>;
}

export async function bulkUpdateProjects(
  updates: BulkUpdateProjectItem[]
): Promise<void> {
  const response = await makeRequest('/v1/projects/bulk', {
    method: 'POST',
    body: JSON.stringify({
      updates: updates.map((u) => ({ id: u.id, ...u.changes })),
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to bulk update projects');
  }
}

export async function bulkUpdateIssues(
  updates: BulkUpdateIssueItem[]
): Promise<void> {
  const response = await makeRequest('/v1/issues/bulk', {
    method: 'POST',
    body: JSON.stringify({
      updates: updates.map((u) => ({ id: u.id, ...u.changes })),
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to bulk update issues');
  }
}

export interface BulkUpdateProjectStatusItem {
  id: string;
  changes: Partial<UpdateProjectStatusRequest>;
}

export async function bulkUpdateProjectStatuses(
  updates: BulkUpdateProjectStatusItem[]
): Promise<void> {
  const response = await makeRequest('/v1/project_statuses/bulk', {
    method: 'POST',
    body: JSON.stringify({
      updates: updates.map((u) => ({ id: u.id, ...u.changes })),
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to bulk update project statuses');
  }
}
