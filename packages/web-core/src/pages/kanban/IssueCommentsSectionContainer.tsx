import {
  useMemo,
  useCallback,
  useState,
  useRef,
  useEffect,
  type Ref,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { IssueProvider } from '@/integrations/remote/IssueProvider';
import { useIssueContext } from '@/shared/hooks/useIssueContext';
import { useScratch } from '@/shared/hooks/useScratch';
import { useDebouncedCallback } from '@/shared/hooks/useDebouncedCallback';
import { useIssueAttachments } from '@/shared/hooks/useIssueAttachments';
import { attachmentsApi } from '@/shared/lib/api';
import {
  IssueCommentsSection,
  type IssueCommentsEditorProps,
  type IssueCommentData,
} from '@vibe/ui/components/IssueCommentsSection';
import WYSIWYGEditor, {
  type WYSIWYGEditorRef,
} from '@/shared/components/WYSIWYGEditor';
import { ScratchType } from 'shared/types';

interface IssueCommentsSectionContainerProps {
  issueId: string;
}

/**
 * Container that wraps IssueCommentsSection with IssueProvider.
 * Manages comment data transformation, mutations, and UI state.
 */
export function IssueCommentsSectionContainer({
  issueId,
}: IssueCommentsSectionContainerProps) {
  return (
    <IssueProvider issueId={issueId}>
      <IssueCommentsSectionContent />
    </IssueProvider>
  );
}

function IssueCommentsSectionContent() {
  const issueContext = useIssueContext();

  // Ref to comment editor for programmatic focus
  const commentEditorRef = useRef<WYSIWYGEditorRef>(null);

  // UI state for comment input
  const [commentInput, setCommentInput] = useState('');
  const commentDraftId = `issue-comment:${issueContext.issueId}`;
  const {
    scratch: commentDraftScratch,
    updateScratch: updateCommentDraft,
    deleteScratch: deleteCommentDraft,
    isLoading: isCommentDraftLoading,
  } = useScratch(ScratchType.DRAFT_TASK, commentDraftId);
  const commentDraft =
    commentDraftScratch?.payload?.type === 'DRAFT_TASK'
      ? commentDraftScratch.payload.data
      : undefined;
  const hydratedCommentDraftIdRef = useRef<string | null>(null);
  const skipNextPersistRef = useRef(false);

  const persistCommentDraft = useCallback(
    async (value: string) => {
      try {
        if (!value.trim()) {
          await deleteCommentDraft();
          return;
        }

        await updateCommentDraft({
          payload: {
            type: 'DRAFT_TASK',
            data: value,
          },
        });
      } catch (e) {
        console.error('[IssueCommentsSection] Failed to persist draft:', e);
      }
    },
    [updateCommentDraft, deleteCommentDraft]
  );

  const {
    debounced: debouncedPersistCommentDraft,
    cancel: cancelDebouncedPersistCommentDraft,
  } = useDebouncedCallback(persistCommentDraft, 500);

  useEffect(() => {
    cancelDebouncedPersistCommentDraft();
    hydratedCommentDraftIdRef.current = null;
    skipNextPersistRef.current = false;
    setCommentInput('');
  }, [commentDraftId, cancelDebouncedPersistCommentDraft]);

  useEffect(() => {
    if (isCommentDraftLoading) return;
    if (hydratedCommentDraftIdRef.current === commentDraftId) return;

    const nextCommentInput = commentDraft ?? '';
    const shouldSkipNextPersist = nextCommentInput !== commentInput;

    hydratedCommentDraftIdRef.current = commentDraftId;
    skipNextPersistRef.current = shouldSkipNextPersist;
    setCommentInput(nextCommentInput);
  }, [isCommentDraftLoading, commentDraft, commentDraftId, commentInput]);

  const handleCommentMarkdownInsert = useCallback((markdown: string) => {
    setCommentInput((prev) =>
      prev.trim() ? `${prev}\n\n${markdown}` : markdown
    );
  }, []);

  const {
    uploadFiles,
    getAttachmentIds,
    clearAttachments,
    isUploading,
    uploadError,
    clearUploadError,
    localAttachments,
  } = useIssueAttachments(handleCommentMarkdownInsert);

  useEffect(() => {
    if (hydratedCommentDraftIdRef.current !== commentDraftId) return;
    if (isUploading) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }

    debouncedPersistCommentDraft(commentInput);
  }, [commentInput, commentDraftId, debouncedPersistCommentDraft, isUploading]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: (acceptedFiles) => {
      if (acceptedFiles.length > 0) uploadFiles(acceptedFiles);
    },
    multiple: true,
    noClick: true,
    noKeyboard: true,
  });

  const onPasteFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0) uploadFiles(files);
    },
    [uploadFiles]
  );

  // UI state for editing
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  // Transform IssueComment to IssueCommentData. ADR-019: no author attribution
  // (single-developer fork — every comment is the owner's, no display needed).
  const commentsData = useMemo<IssueCommentData[]>(() => {
    return issueContext.comments
      .map((comment) => ({
        id: comment.id,
        message: comment.message,
        createdAt: comment.created_at,
        canModify: true,
      }))
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
  }, [issueContext.comments]);

  const handleSubmitComment = useCallback(async () => {
    if (!commentInput.trim()) return;
    const message = commentInput.trim();
    const { persisted } = issueContext.insertComment({
      issue_id: issueContext.issueId,
      message,
      parent_id: null,
    });
    cancelDebouncedPersistCommentDraft();
    setCommentInput('');
    try {
      await deleteCommentDraft();
    } catch (e) {
      console.error('[IssueCommentsSection] Failed to clear draft:', e);
    }

    const allUploadedIds = getAttachmentIds();
    if (allUploadedIds.length > 0) {
      try {
        const confirmedComment = await persisted;
        await attachmentsApi.linkCommentAttachments(
          confirmedComment.id,
          allUploadedIds
        );
      } catch (err) {
        console.error('Failed to link comment attachments:', err);
      }
    }
    clearAttachments();
  }, [
    commentInput,
    issueContext,
    getAttachmentIds,
    clearAttachments,
    cancelDebouncedPersistCommentDraft,
    deleteCommentDraft,
  ]);

  const handleStartEdit = useCallback(
    (commentId: string) => {
      const comment = commentsData.find((c) => c.id === commentId);
      if (comment) {
        setEditingCommentId(commentId);
        setEditingValue(comment.message);
      }
    },
    [commentsData]
  );

  const handleSaveEdit = useCallback(() => {
    if (!editingCommentId || !editingValue.trim()) return;
    issueContext.updateComment(editingCommentId, {
      message: editingValue.trim(),
    });
    setEditingCommentId(null);
    setEditingValue('');
  }, [editingCommentId, editingValue, issueContext]);

  const handleCancelEdit = useCallback(() => {
    setEditingCommentId(null);
    setEditingValue('');
  }, []);

  const handleDeleteComment = useCallback(
    (id: string) => {
      issueContext.removeComment(id);
    },
    [issueContext]
  );

  const renderEditor = useCallback(
    ({
      value,
      onChange,
      placeholder,
      className,
      disabled,
      autoFocus,
      onCmdEnter,
      onPasteFiles,
      localAttachments,
      editorRef,
    }: IssueCommentsEditorProps) => (
      <WYSIWYGEditor
        ref={editorRef as Ref<WYSIWYGEditorRef>}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
        autoFocus={autoFocus}
        onCmdEnter={onCmdEnter}
        onPasteFiles={onPasteFiles}
        localAttachments={localAttachments}
      />
    ),
    []
  );

  return (
    <IssueCommentsSection
      comments={commentsData}
      commentInput={commentInput}
      onCommentInputChange={setCommentInput}
      onSubmitComment={handleSubmitComment}
      editingCommentId={editingCommentId}
      editingValue={editingValue}
      onEditingValueChange={setEditingValue}
      onStartEdit={handleStartEdit}
      onSaveEdit={handleSaveEdit}
      onCancelEdit={handleCancelEdit}
      onDeleteComment={handleDeleteComment}
      isLoading={issueContext.isLoading}
      commentEditorRef={commentEditorRef}
      onPasteFiles={onPasteFiles}
      localAttachments={localAttachments}
      dropzoneProps={{ getRootProps, getInputProps, isDragActive }}
      onBrowseAttachment={open}
      isUploading={isUploading}
      attachmentError={uploadError}
      onDismissAttachmentError={clearUploadError}
      renderEditor={renderEditor}
    />
  );
}
