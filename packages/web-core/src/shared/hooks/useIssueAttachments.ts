import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AttachmentResponse } from 'shared/types';
import type { LocalAttachmentMetadata } from '@vibe/ui/components/WorkspaceContext';
import { attachmentsApi } from '@/shared/lib/api';
import {
  buildIssueAttachmentMarkdown,
  toIssueLocalAttachmentMetadata,
} from '@/shared/lib/workspaceAttachments';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_BATCH_SIZE = 10;

export interface UseIssueAttachmentsReturn {
  uploadFiles: (files: File[]) => Promise<void>;
  uploadedAttachments: AttachmentResponse[];
  getAttachmentIds: () => string[];
  clearAttachments: () => void;
  isUploading: boolean;
  uploadError: string | null;
  clearUploadError: () => void;
  localAttachments: LocalAttachmentMetadata[];
}

export function useIssueAttachments(
  onInsertMarkdown: (markdown: string) => void
): UseIssueAttachmentsReturn {
  const { t } = useTranslation('common');
  const [uploadedAttachments, setUploadedAttachments] = useState<
    AttachmentResponse[]
  >([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onInsertMarkdownRef = useRef(onInsertMarkdown);
  onInsertMarkdownRef.current = onInsertMarkdown;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      setUploadError(null);

      if (files.length > MAX_BATCH_SIZE) {
        setUploadError(t('kanban.maxFilesAtOnce', { count: MAX_BATCH_SIZE }));
        return;
      }

      const validFiles: File[] = [];
      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          setUploadError(t('kanban.fileExceedsLimit', { filename: file.name }));
          continue;
        }
        validFiles.push(file);
      }

      if (validFiles.length === 0) return;

      setIsUploading(true);

      try {
        for (const file of validFiles) {
          try {
            const response = await attachmentsApi.upload(file);
            setUploadedAttachments((prev) => [...prev, response]);
            onInsertMarkdownRef.current(buildIssueAttachmentMarkdown(response));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : t('kanban.unknownError');
            setUploadError(
              t('kanban.failedToUploadFile', {
                filename: file.name,
                message,
              })
            );
          }
        }
      } finally {
        setIsUploading(false);
      }
    },
    [t]
  );

  const getAttachmentIds = useCallback(
    () => uploadedAttachments.map((a) => a.id),
    [uploadedAttachments]
  );

  const clearAttachments = useCallback(() => {
    setUploadedAttachments([]);
    setUploadError(null);
  }, []);

  const clearUploadError = useCallback(() => {
    setUploadError(null);
  }, []);

  const localAttachments = uploadedAttachments.map(
    toIssueLocalAttachmentMetadata
  );

  return {
    uploadFiles,
    uploadedAttachments,
    getAttachmentIds,
    clearAttachments,
    isUploading,
    uploadError,
    clearUploadError,
    localAttachments,
  };
}
