import { useMemo, useState } from 'react';
import {
  CheckIcon,
  XIcon,
  ShieldWarningIcon,
  QuestionIcon,
  ClipboardTextIcon,
} from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import type { ApprovalInfo, ApprovalQuestion } from 'shared/types';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { useApprovalMutation } from '@/features/workspace-chat/model/hooks/useApprovalMutation';

interface HeadedApprovalsPanelProps {
  executionProcessId: string;
}

/**
 * Pending approvals for a headed (interactive tmux) execution.
 *
 * Headed sessions gate tool use — and, in plan mode, `AskUserQuestion`
 * questionnaires and `ExitPlanMode` plan approvals — through an injected
 * `PreToolUse` command hook that parks a request on the backend's `Approvals`
 * store. Those pending approvals arrive here via the same global
 * `useApprovals()` stream the headless path uses, now carrying inline
 * question/plan content so the operator can answer/approve without attaching the
 * terminal. Renders nothing when there are no pending approvals for this process.
 */
export function HeadedApprovalsPanel({
  executionProcessId,
}: HeadedApprovalsPanelProps) {
  const { pendingApprovals } = useApprovals();

  const pending = useMemo(
    () =>
      pendingApprovals.filter(
        (a) => a.execution_process_id === executionProcessId
      ),
    [pendingApprovals, executionProcessId]
  );

  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col gap-half px-base py-half border-b border-border bg-tertiary shrink-0">
      {pending.map((a) =>
        a.kind === 'question' ? (
          <QuestionApproval
            key={a.approval_id}
            approval={a}
            executionProcessId={executionProcessId}
          />
        ) : a.kind === 'plan_approval' ? (
          <PlanApproval
            key={a.approval_id}
            approval={a}
            executionProcessId={executionProcessId}
          />
        ) : (
          <ToolApproval
            key={a.approval_id}
            approval={a}
            executionProcessId={executionProcessId}
          />
        )
      )}
    </div>
  );
}

function ToolApproval({
  approval,
  executionProcessId,
}: {
  approval: ApprovalInfo;
  executionProcessId: string;
}) {
  const { approve, deny } = useApprovalMutation();
  return (
    <div className="flex items-center gap-2 min-w-0 text-xs">
      <ShieldWarningIcon
        className="size-icon-sm shrink-0 text-warning"
        weight="fill"
      />
      <span className="min-w-0 truncate text-normal">
        Approve{' '}
        <code className="font-mono text-high">{approval.tool_name}</code>?
      </span>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <Button
          variant="secondary"
          size="xs"
          className="gap-half"
          onClick={() =>
            approve({ approvalId: approval.approval_id, executionProcessId })
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
            deny({ approvalId: approval.approval_id, executionProcessId })
          }
        >
          <XIcon className="size-icon-sm" weight="bold" />
          Deny
        </Button>
      </div>
    </div>
  );
}

function PlanApproval({
  approval,
  executionProcessId,
}: {
  approval: ApprovalInfo;
  executionProcessId: string;
}) {
  const { approve, deny } = useApprovalMutation();
  const [showPlan, setShowPlan] = useState(false);
  const plan = approval.plan_content ?? '';

  return (
    <div className="flex flex-col gap-half min-w-0 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <ClipboardTextIcon
          className="size-icon-sm shrink-0 text-info"
          weight="fill"
        />
        <span className="min-w-0 truncate text-normal">
          Agent finished planning — approve the plan?
        </span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {plan && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setShowPlan((v) => !v)}
            >
              {showPlan ? 'Hide plan' : 'View plan'}
            </Button>
          )}
          <Button
            variant="secondary"
            size="xs"
            className="gap-half"
            onClick={() =>
              approve({ approvalId: approval.approval_id, executionProcessId })
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
              deny({
                approvalId: approval.approval_id,
                executionProcessId,
                reason: 'Please revise the plan and re-present.',
              })
            }
          >
            <XIcon className="size-icon-sm" weight="bold" />
            Request changes
          </Button>
        </div>
      </div>
      {showPlan && plan && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-secondary p-2 text-2xs text-normal">
          {plan}
        </pre>
      )}
    </div>
  );
}

function QuestionApproval({
  approval,
  executionProcessId,
}: {
  approval: ApprovalInfo;
  executionProcessId: string;
}) {
  const { answer, isAnswering } = useApprovalMutation();
  const questions: ApprovalQuestion[] = useMemo(
    () => approval.questions ?? [],
    [approval.questions]
  );
  // selections[questionIndex] = set of chosen option labels
  const [selections, setSelections] = useState<Record<number, string[]>>({});

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const current = prev[qIdx] ?? [];
      if (multi) {
        return {
          ...prev,
          [qIdx]: current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label],
        };
      }
      return { ...prev, [qIdx]: [label] };
    });
  };

  const allAnswered = questions.every(
    (_, i) => (selections[i]?.length ?? 0) > 0
  );

  const submit = () => {
    if (!allAnswered) return;
    answer({
      approvalId: approval.approval_id,
      executionProcessId,
      answers: questions.map((q, i) => ({
        question: q.question,
        answer: selections[i] ?? [],
      })),
    });
  };

  return (
    <div className="flex flex-col gap-half min-w-0 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <QuestionIcon
          className="size-icon-sm shrink-0 text-info"
          weight="fill"
        />
        <span className="min-w-0 truncate text-normal">
          The agent is waiting for your answer
        </span>
      </div>
      {questions.map((q, qIdx) => {
        const chosen = selections[qIdx] ?? [];
        return (
          <div key={qIdx} className="flex flex-col gap-half pl-icon-md">
            <span className="text-high">
              {q.header ? `${q.header}: ` : ''}
              {q.question}
              {q.multiSelect && (
                <span className="text-low"> (select all that apply)</span>
              )}
            </span>
            <div className="flex flex-wrap gap-half">
              {q.options.map((opt) => {
                const selected = chosen.includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    title={opt.description ?? undefined}
                    onClick={() => toggle(qIdx, opt.label, q.multiSelect)}
                    className={`rounded border px-2 py-half text-left transition-colors ${
                      selected
                        ? 'border-info bg-info/10 text-high'
                        : 'border-border text-normal hover:bg-secondary'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="xs"
          className="gap-half"
          disabled={!allAnswered || isAnswering}
          onClick={submit}
        >
          <CheckIcon className="size-icon-sm" weight="bold" />
          Submit answers
        </Button>
      </div>
    </div>
  );
}
