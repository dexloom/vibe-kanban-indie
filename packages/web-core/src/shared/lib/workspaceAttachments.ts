import type { AttachmentResponse } from 'shared/types';
import type { LocalAttachmentMetadata } from '@vibe/ui/components/WorkspaceContext';

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[[\]\\]/g, '\\$&');
}

export function isImageMimeType(mimeType?: string | null): boolean {
  return mimeType?.startsWith('image/') ?? false;
}

export function buildAttachmentMarkdown(attachment: {
  name: string;
  src: string;
  mimeType?: string | null;
}): string {
  const label = escapeMarkdownLabel(attachment.name);
  if (isImageMimeType(attachment.mimeType)) {
    return `![${label}](${attachment.src})`;
  }
  return `[${label}](${attachment.src})`;
}

export function buildWorkspaceAttachmentMarkdown(attachment: {
  original_name: string;
  file_path: string;
  mime_type?: string | null;
}): string {
  return buildAttachmentMarkdown({
    name: attachment.original_name,
    src: attachment.file_path,
    mimeType: attachment.mime_type,
  });
}

export function buildIssueAttachmentMarkdown(a: AttachmentResponse): string {
  const src = `/api/attachments/${a.id}/file`;
  return buildAttachmentMarkdown({
    name: a.original_name,
    src,
    mimeType: a.mime_type,
  });
}

export function toLocalAttachmentMetadata(
  attachment: AttachmentResponse
): LocalAttachmentMetadata {
  return {
    path: attachment.file_path,
    proxy_url: `/api/attachments/${attachment.id}/file`,
    file_name: attachment.original_name,
    size_bytes: Number(attachment.size_bytes),
    format: attachment.mime_type?.split('/')[1] ?? 'bin',
    mime_type: attachment.mime_type ?? 'application/octet-stream',
  };
}

export function toIssueLocalAttachmentMetadata(
  a: AttachmentResponse
): LocalAttachmentMetadata {
  const src = `/api/attachments/${a.id}/file`;
  return {
    path: src,
    proxy_url: src,
    file_name: a.original_name,
    size_bytes: Number(a.size_bytes),
    format: a.mime_type?.split('/')[1] ?? 'bin',
    mime_type: a.mime_type ?? 'application/octet-stream',
  };
}
