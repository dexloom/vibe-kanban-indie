import { ApiError } from '@/shared/lib/api';

export const WORKSPACE_ALREADY_LINKED_MESSAGE =
  'This workspace is already linked to an issue.';

export function getLinkWorkspaceErrorMessage(error: unknown): string | null {
  if (error instanceof ApiError && error.status === 409) {
    return WORKSPACE_ALREADY_LINKED_MESSAGE;
  }

  if (error instanceof Error) {
    const normalizedMessage = error.message.toLowerCase();
    if (
      normalizedMessage.includes('already exists') ||
      normalizedMessage.includes('already linked')
    ) {
      return WORKSPACE_ALREADY_LINKED_MESSAGE;
    }
    return error.message;
  }

  return null;
}
