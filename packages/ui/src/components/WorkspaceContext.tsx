import { createContext, useContext } from 'react';

export const WorkspaceContext = createContext<string | undefined>(undefined);
export const SessionContext = createContext<string | undefined>(undefined);

export function useWorkspaceId() {
  return useContext(WorkspaceContext);
}

export function useSessionId() {
  return useContext(SessionContext);
}

// Local attachment metadata for rendering uploaded attachments before they're saved
export type LocalAttachmentMetadata = {
  path: string; // ".vibe-attachments/uuid.png"
  proxy_url: string; // "/api/attachments/{id}/file"
  file_name: string;
  size_bytes: number;
  format: string;
  mime_type: string;
};

export const LocalAttachmentsContext = createContext<LocalAttachmentMetadata[]>(
  []
);

export function useLocalAttachments() {
  return useContext(LocalAttachmentsContext);
}
