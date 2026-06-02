import { useMemo } from 'react';
import { CheckIcon, XIcon, ShieldWarningIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { useApprovalMutation } from '@/features/workspace-chat/model/hooks/useApprovalMutation';

interface HeadedApprovalsPanelProps {
  executionProcessId: string;
}

/**
 * Pending tool-approval prompts for a headed (interactive tmux) execution.
 *
 * Headed sessions gate tool use through an injected `PreToolUse` command hook
 * that parks a request on the backend's `Approvals` store; those pending
 * approvals arrive here via the same global `useApprovals()` stream the headless
 * path uses. Approving/denying calls the shared `respond` endpoint, which
 * unblocks the hook so Claude runs (or skips) the tool. Renders nothing when
 * there are no pending tool approvals for this process.
 */
export function HeadedApprovalsPanel({
  executionProcessId,
}: HeadedApprovalsPanelProps) {
  const { pendingApprovals } = useApprovals();
  const { approve, deny } = useApprovalMutation();

  const pending = useMemo(
    () =>
      pendingApprovals.filter(
        (a) => a.execution_process_id === executionProcessId && !a.is_question
      ),
    [pendingApprovals, executionProcessId]
  );

  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col gap-half px-base py-half border-b border-border bg-tertiary shrink-0">
      {pending.map((a) => (
        <div
          key={a.approval_id}
          className="flex items-center gap-2 min-w-0 text-xs"
        >
          <ShieldWarningIcon
            className="size-icon-sm shrink-0 text-warning"
            weight="fill"
          />
          <span className="min-w-0 truncate text-normal">
            Approve <code className="font-mono text-high">{a.tool_name}</code>?
          </span>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="xs"
              className="gap-half"
              onClick={() =>
                approve({ approvalId: a.approval_id, executionProcessId })
              }
            >
              <CheckIcon className="size-icon-sm" weight="bold" />
              Approve
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="gap-half"
              onClick={() =>
                deny({ approvalId: a.approval_id, executionProcessId })
              }
            >
              <XIcon className="size-icon-sm" weight="bold" />
              Deny
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
