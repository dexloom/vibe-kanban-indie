import type {
  Config,
  GetMcpServerResponse,
  GitBranch,
  McpServerQuery,
  Repo,
  UpdateMcpServersBody,
  UpdateRepo,
  UserSystemInfo,
} from 'shared/types';
import { handleApiResponse } from './api';
import {
  makeLocalApiRequest,
  type LocalApiRequestOptions,
} from './localApiTransport';

export type MachineTarget =
  | {
      kind: 'local';
      id: 'local';
      apiHostId: null;
      label: string;
    }
  | {
      kind: 'remote';
      id: string;
      apiHostId: string;
      label: string;
    };

export interface MachineClient {
  target: MachineTarget;
  queryScopeKey: readonly ['machine', string];
  getConfig: () => Promise<UserSystemInfo>;
  saveConfig: (config: Config) => Promise<Config>;
  listRepos: () => Promise<Repo[]>;
  updateRepo: (repoId: string, data: UpdateRepo) => Promise<Repo>;
  deleteRepo: (repoId: string) => Promise<void>;
  registerRepo: (data: {
    path: string;
    display_name?: string;
  }) => Promise<Repo>;
  getRepoBranches: (repoId: string) => Promise<GitBranch[]>;
  loadProfiles: () => Promise<{ content: string; path: string }>;
  saveProfiles: (content: string) => Promise<string>;
  loadMcpServers: (query: McpServerQuery) => Promise<GetMcpServerResponse>;
  saveMcpServers: (
    query: McpServerQuery,
    data: UpdateMcpServersBody
  ) => Promise<void>;
}

function getMachineRequestOptions(
  target: MachineTarget
): LocalApiRequestOptions {
  if (target.apiHostId) {
    return {
      hostScope: 'explicit',
      hostId: target.apiHostId,
    };
  }

  return {
    hostScope: 'none',
  };
}

async function makeMachineRequest(
  target: MachineTarget,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return makeLocalApiRequest(path, {
    ...options,
    headers,
    ...getMachineRequestOptions(target),
  });
}

export function createMachineClient(target: MachineTarget): MachineClient {
  const queryScopeKey = ['machine', target.id] as const;

  return {
    target,
    queryScopeKey,
    getConfig: async () =>
      handleApiResponse<UserSystemInfo>(
        await makeMachineRequest(target, '/api/info', {
          cache: 'no-store',
        })
      ),
    saveConfig: async (config) =>
      handleApiResponse<Config>(
        await makeMachineRequest(target, '/api/config', {
          method: 'PUT',
          body: JSON.stringify(config),
        })
      ),
    listRepos: async () =>
      handleApiResponse<Repo[]>(await makeMachineRequest(target, '/api/repos')),
    updateRepo: async (repoId, data) =>
      handleApiResponse<Repo>(
        await makeMachineRequest(target, `/api/repos/${repoId}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        })
      ),
    deleteRepo: async (repoId) =>
      handleApiResponse<void>(
        await makeMachineRequest(target, `/api/repos/${repoId}`, {
          method: 'DELETE',
        })
      ),
    registerRepo: async (data) =>
      handleApiResponse<Repo>(
        await makeMachineRequest(target, '/api/repos', {
          method: 'POST',
          body: JSON.stringify(data),
        })
      ),
    getRepoBranches: async (repoId) =>
      handleApiResponse<GitBranch[]>(
        await makeMachineRequest(target, `/api/repos/${repoId}/branches`)
      ),
    loadProfiles: async () =>
      handleApiResponse<{ content: string; path: string }>(
        await makeMachineRequest(target, '/api/profiles')
      ),
    saveProfiles: async (content) =>
      handleApiResponse<string>(
        await makeMachineRequest(target, '/api/profiles', {
          method: 'PUT',
          body: content,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      ),
    loadMcpServers: async (query) => {
      const params = new URLSearchParams(query);
      return handleApiResponse<GetMcpServerResponse>(
        await makeMachineRequest(target, `/api/mcp-config?${params.toString()}`)
      );
    },
    saveMcpServers: async (query, data) => {
      const params = new URLSearchParams(query);
      await handleApiResponse<void>(
        await makeMachineRequest(
          target,
          `/api/mcp-config?${params.toString()}`,
          {
            method: 'POST',
            body: JSON.stringify(data),
          }
        )
      );
    },
  };
}
