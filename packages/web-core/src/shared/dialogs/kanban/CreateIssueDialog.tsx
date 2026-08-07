import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { SpinnerIcon } from '@phosphor-icons/react';
import type { IssuePriority, JsonValue } from 'shared/remote-types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { AutoExpandingTextarea } from '@vibe/ui/components/AutoExpandingTextarea';
import { defineModal, getErrorMessage } from '@/shared/lib/modals';
import { useDebouncedCallback } from '@/shared/hooks/useDebouncedCallback';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import {
  PipelineSection,
  type PipelineSelection,
} from '@/pages/kanban/PipelineSection';
import { appendPipelineToDescription } from '@/shared/lib/pipeline/cardPipeline';
import { CreateIssueLinkedSections } from './CreateIssueLinkedSections';

export interface CreateIssueDialogPriorityOption {
  value: IssuePriority;
  label: string;
}

export interface CreateIssueDialogStatusOption {
  id: string;
  name: string;
}

export interface CreateIssueDialogProps {
  projectId: string;
  statuses: CreateIssueDialogStatusOption[];
  defaultStatusId: string;
  priorities: CreateIssueDialogPriorityOption[];
  parentIssueSimpleId?: string | null;
  onCreate: (data: {
    title: string;
    description: string | null;
    statusId: string;
    priority: IssuePriority | null;
    extensionMetadata: JsonValue;
  }) => Promise<string>;
  onUpdate: (
    issueId: string,
    changes: {
      title: string;
      description: string | null;
      statusId: string;
      priority: IssuePriority | null;
      extensionMetadata: JsonValue;
    }
  ) => void;
}

export type CreateIssueDialogResult =
  | { action: 'created'; issueId: string }
  | { action: 'canceled' };

const NONE_PRIORITY_VALUE = '__none__';

const CreateIssueDialogImpl = NiceModal.create<CreateIssueDialogProps>(
  ({
    projectId,
    statuses,
    defaultStatusId,
    priorities,
    parentIssueSimpleId = null,
    onCreate,
    onUpdate,
  }) => {
    const modal = useModal();
    const { t } = useTranslation('common');
    const { profiles } = useUserSystem();

    const titleInputRef = useRef<HTMLInputElement | null>(null);
    const descriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const pipelineSelectionRef = useRef<PipelineSelection | null>(null);

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [statusId, setStatusId] = useState<string>(defaultStatusId);
    const [priority, setPriority] = useState<string>(NONE_PRIORITY_VALUE);
    const [savedIssueId, setSavedIssueId] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const buildPersistedDescription = useCallback((rawDescription: string) => {
      const trimmed = rawDescription.trim();
      const raw = trimmed.length > 0 ? trimmed : null;
      const block = pipelineSelectionRef.current?.block ?? '';
      return block ? appendPipelineToDescription(raw, block) : raw;
    }, []);

    const buildExtensionMetadata = useCallback((): JsonValue => {
      const selection = pipelineSelectionRef.current;
      if (!selection) {
        return {};
      }
      return {
        pipeline: {
          pipelineIds: selection.pipelineIds,
          enabledIds: selection.enabledIds,
          executor: selection.executor,
          customText: selection.customText,
        },
      };
    }, []);

    const buildUpdatePatch = useCallback(() => {
      return {
        title: title.trim(),
        description: buildPersistedDescription(description),
        statusId,
        priority:
          priority === NONE_PRIORITY_VALUE ? null : (priority as IssuePriority),
        extensionMetadata: buildExtensionMetadata(),
      };
    }, [
      title,
      description,
      statusId,
      priority,
      buildPersistedDescription,
      buildExtensionMetadata,
    ]);

    const dirtyRef = useRef(false);
    const { debounced: scheduleAutoSave, cancel: cancelAutoSave } =
      useDebouncedCallback(() => {
        if (!savedIssueId) return;
        dirtyRef.current = false;
        onUpdate(savedIssueId, buildUpdatePatch());
      }, 500);

    const markDirty = useCallback(() => {
      if (!savedIssueId) return;
      dirtyRef.current = true;
      scheduleAutoSave();
    }, [savedIssueId, scheduleAutoSave]);

    const flushAutoSave = useCallback(() => {
      cancelAutoSave();
      if (savedIssueId && dirtyRef.current) {
        dirtyRef.current = false;
        onUpdate(savedIssueId, buildUpdatePatch());
      }
    }, [cancelAutoSave, savedIssueId, onUpdate, buildUpdatePatch]);

    const handlePipelineChange = useCallback(
      (selection: PipelineSelection) => {
        pipelineSelectionRef.current = selection;
        markDirty();
      },
      [markDirty]
    );

    // Auto-focus the title input when the dialog becomes visible.
    useEffect(() => {
      if (!modal.visible) return;
      const id = window.requestAnimationFrame(() => {
        titleInputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }, [modal.visible]);

    // Reset form state each time the dialog opens, so a previous failed submit
    // doesn't leak into a fresh attempt.
    useEffect(() => {
      if (!modal.visible) return;
      setTitle('');
      setDescription('');
      setStatusId(defaultStatusId);
      setPriority(NONE_PRIORITY_VALUE);
      setSavedIssueId(null);
      pipelineSelectionRef.current = null;
      dirtyRef.current = false;
      cancelAutoSave();
      setError(null);
      setIsSubmitting(false);
    }, [modal.visible, defaultStatusId, cancelAutoSave]);

    const handleClose = useCallback(() => {
      flushAutoSave();
      if (savedIssueId) {
        modal.resolve({ action: 'created', issueId: savedIssueId });
      } else {
        modal.resolve({ action: 'canceled' });
      }
      modal.hide();
    }, [flushAutoSave, modal, savedIssueId]);

    const handleCancel = useCallback(() => {
      handleClose();
    }, [handleClose]);

    const canSubmit = title.trim().length > 0 && !isSubmitting;
    const hasStatuses = statuses.length > 0;
    const hasPriorities = priorities.length > 0;

    const handleSubmit = useCallback(async () => {
      if (savedIssueId) {
        return;
      }
      const trimmedTitle = title.trim();
      if (!trimmedTitle || isSubmitting) {
        return;
      }
      if (!statusId) {
        setError(t('createIssueDialog.errorCreateFailed'));
        return;
      }

      setIsSubmitting(true);
      setError(null);
      try {
        const newIssueId = await onCreate(buildUpdatePatch());

        setSavedIssueId(newIssueId);
      } catch (err) {
        setError(
          getErrorMessage(err) || t('createIssueDialog.errorCreateFailed')
        );
      } finally {
        setIsSubmitting(false);
      }
    }, [
      savedIssueId,
      title,
      isSubmitting,
      statusId,
      onCreate,
      buildUpdatePatch,
      t,
    ]);

    // Enter submits when focus is in the title input; Cmd/Ctrl+Enter submits
    // globally. While the textarea is focused, Enter is left alone so the user
    // can add line breaks.
    const handleTitleKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void handleSubmit();
        }
      },
      [handleSubmit]
    );

    const handleDescriptionKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (
          event.key === 'Enter' &&
          (event.metaKey || event.ctrlKey) &&
          canSubmit
        ) {
          event.preventDefault();
          void handleSubmit();
        }
      },
      [handleSubmit, canSubmit]
    );

    // Overlay close (Esc, click outside) MUST resolve so the awaiting caller
    // never hangs.
    const handleOpenChange = useCallback(
      (open: boolean) => {
        if (!open) {
          handleCancel();
        }
      },
      [handleCancel]
    );

    const parentHint = useMemo(() => {
      if (!parentIssueSimpleId) {
        return null;
      }
      return t('createIssueDialog.parentHint', { id: parentIssueSimpleId });
    }, [parentIssueSimpleId, t]);

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle>{t('createIssueDialog.title')}</DialogTitle>
            {parentHint ? (
              <DialogDescription>{parentHint}</DialogDescription>
            ) : null}
          </DialogHeader>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto py-2 min-h-0">
            <div className="flex flex-col gap-2">
              <input
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  markDirty();
                }}
                onKeyDown={handleTitleKeyDown}
                placeholder={t('createIssueDialog.titlePlaceholder')}
                disabled={isSubmitting}
                aria-label={t('createIssueDialog.titlePlaceholder')}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="flex flex-col gap-2">
              <AutoExpandingTextarea
                ref={descriptionTextareaRef}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  markDirty();
                }}
                onKeyDown={handleDescriptionKeyDown}
                placeholder={t('createIssueDialog.descriptionPlaceholder')}
                disabled={isSubmitting}
                rows={4}
                maxRows={10}
                className="rounded-md border border-input px-3 py-2"
              />
            </div>

            <div className="flex items-end gap-3">
              <div className="flex flex-1 flex-col gap-1">
                <label className="text-xs font-medium text-low">
                  {t('createIssueDialog.statusLabel')}
                </label>
                <Select
                  value={statusId}
                  onValueChange={(value) => {
                    setStatusId(value);
                    markDirty();
                  }}
                  disabled={isSubmitting || !hasStatuses}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t('createIssueDialog.statusLabel')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((status) => (
                      <SelectItem key={status.id} value={status.id}>
                        {status.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <label className="text-xs font-medium text-low">
                  {t('createIssueDialog.priorityLabel')}
                </label>
                <Select
                  value={priority}
                  onValueChange={(value) => {
                    setPriority(value);
                    markDirty();
                  }}
                  disabled={isSubmitting || !hasPriorities}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t('createIssueDialog.priorityLabel')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_PRIORITY_VALUE}>
                      {t('form.notSpecified')}
                    </SelectItem>
                    {priorities.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <PipelineSection
              profiles={profiles}
              disabled={isSubmitting}
              expanded
              onChange={handlePipelineChange}
            />

            <CreateIssueLinkedSections
              projectId={projectId}
              issueId={savedIssueId}
            />

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isSubmitting}
            >
              {savedIssueId
                ? t('createIssueDialog.close')
                : t('createIssueDialog.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit || savedIssueId !== null}
            >
              {isSubmitting ? (
                <>
                  <SpinnerIcon className="h-4 w-4 animate-spin mr-2" />
                  {t('createIssueDialog.save')}
                </>
              ) : (
                t('createIssueDialog.save')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const CreateIssueDialog = defineModal<
  CreateIssueDialogProps,
  CreateIssueDialogResult
>(CreateIssueDialogImpl);
