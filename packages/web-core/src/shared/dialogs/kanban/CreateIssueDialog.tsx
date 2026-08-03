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
import {
  GitBranchIcon,
  PlusIcon,
  SpinnerIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { IssuePriority } from 'shared/remote-types';
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

export interface CreateIssueDialogPriorityOption {
  value: IssuePriority;
  label: string;
}

export interface CreateIssueDialogStatusOption {
  id: string;
  name: string;
}

export interface CreateIssueDialogWorkspaceOption {
  id: string;
  name: string;
  branch: string;
  isArchived: boolean;
}

export type CreateIssueDialogWorkspaceSelection =
  { kind: 'none' } | { kind: 'existing'; id: string } | { kind: 'new' };

export interface CreateIssueDialogProps {
  statuses: CreateIssueDialogStatusOption[];
  defaultStatusId: string;
  priorities: CreateIssueDialogPriorityOption[];
  workspaces: CreateIssueDialogWorkspaceOption[];
  parentIssueSimpleId?: string | null;
  onCreate: (data: {
    title: string;
    description: string | null;
    statusId: string;
    priority: IssuePriority | null;
  }) => Promise<string>;
}

export type CreateIssueDialogResult =
  | {
      action: 'created';
      issueId: string;
      workspace: CreateIssueDialogWorkspaceSelection;
    }
  | { action: 'canceled' };

const NONE_PRIORITY_VALUE = '__none__';
const NONE_WORKSPACE_VALUE = '__none__';

const CreateIssueDialogImpl = NiceModal.create<CreateIssueDialogProps>(
  ({
    statuses,
    defaultStatusId,
    priorities,
    workspaces,
    parentIssueSimpleId = null,
    onCreate,
  }) => {
    const modal = useModal();
    const { t } = useTranslation('common');

    const titleInputRef = useRef<HTMLInputElement | null>(null);
    const descriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null);

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [statusId, setStatusId] = useState<string>(defaultStatusId);
    const [priority, setPriority] = useState<string>(NONE_PRIORITY_VALUE);
    const [workspace, setWorkspace] =
      useState<CreateIssueDialogWorkspaceSelection>({ kind: 'none' });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
      setWorkspace({ kind: 'none' });
      setError(null);
      setIsSubmitting(false);
    }, [modal.visible, defaultStatusId]);

    const handleClose = useCallback(
      (result: CreateIssueDialogResult) => {
        modal.resolve(result);
        modal.hide();
      },
      [modal]
    );

    const handleCancel = useCallback(() => {
      handleClose({ action: 'canceled' });
    }, [handleClose]);

    const canSubmit = title.trim().length > 0 && !isSubmitting;
    const hasStatuses = statuses.length > 0;
    const hasPriorities = priorities.length > 0;

    const handleSubmit = useCallback(async () => {
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
        const trimmedDescription = description.trim();
        const resolvedPriority: IssuePriority | null =
          priority === NONE_PRIORITY_VALUE ? null : (priority as IssuePriority);

        const newIssueId = await onCreate({
          title: trimmedTitle,
          description:
            trimmedDescription.length > 0 ? trimmedDescription : null,
          statusId,
          priority: resolvedPriority,
        });

        handleClose({
          action: 'created',
          issueId: newIssueId,
          workspace,
        });
      } catch (err) {
        setError(
          getErrorMessage(err) || t('createIssueDialog.errorCreateFailed')
        );
      } finally {
        setIsSubmitting(false);
      }
    }, [
      title,
      description,
      statusId,
      priority,
      workspace,
      isSubmitting,
      onCreate,
      handleClose,
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
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('createIssueDialog.title')}</DialogTitle>
            {parentHint ? (
              <DialogDescription>{parentHint}</DialogDescription>
            ) : null}
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <input
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
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
                onChange={(event) => setDescription(event.target.value)}
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
                  onValueChange={setStatusId}
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
                  onValueChange={setPriority}
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

            <div className="flex items-end gap-3">
              {workspaces.length > 0 ? (
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <label className="text-xs font-medium text-low">
                    {t('createIssueDialog.workspaceLabel')}
                  </label>
                  <Select
                    value={
                      workspace.kind === 'existing'
                        ? workspace.id
                        : NONE_WORKSPACE_VALUE
                    }
                    onValueChange={(value) =>
                      setWorkspace(
                        value === NONE_WORKSPACE_VALUE
                          ? { kind: 'none' }
                          : { kind: 'existing', id: value }
                      )
                    }
                    disabled={isSubmitting || workspace.kind === 'new'}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={t('createIssueDialog.workspaceNone')}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_WORKSPACE_VALUE}>
                        {t('createIssueDialog.workspaceNone')}
                      </SelectItem>
                      {workspaces.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          <span className="flex min-w-0 items-center gap-2">
                            <GitBranchIcon
                              className="h-4 w-4 shrink-0"
                              weight="regular"
                            />
                            <span className="shrink-0">{option.name}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted">
                              {option.branch}
                            </span>
                            {option.isArchived ? (
                              <span className="shrink-0 text-xs text-subtle">
                                ({t('createIssueDialog.workspaceArchived')})
                              </span>
                            ) : null}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setWorkspace({ kind: 'new' })}
                disabled={isSubmitting}
              >
                <PlusIcon className="h-4 w-4" weight="bold" />
                {t('createIssueDialog.workspaceCreateNew')}
              </Button>
            </div>

            {workspace.kind === 'new' ? (
              <div className="flex items-center gap-3 rounded-md border border-border bg-sunken px-3 py-2 text-sm text-muted">
                <span className="min-w-0 flex-1">
                  {t('createIssueDialog.workspaceWillCreate')}
                </span>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-muted hover:text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  onClick={() => setWorkspace({ kind: 'none' })}
                  aria-label={t('createIssueDialog.workspaceClearSelection')}
                >
                  <XIcon className="h-3.5 w-3.5" weight="bold" />
                  {t('createIssueDialog.workspaceClearSelection')}
                </button>
              </div>
            ) : null}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isSubmitting}
            >
              {t('createIssueDialog.cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {isSubmitting ? (
                <>
                  <SpinnerIcon className="h-4 w-4 animate-spin mr-2" />
                  {t('createIssueDialog.create')}
                </>
              ) : (
                t('createIssueDialog.create')
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
