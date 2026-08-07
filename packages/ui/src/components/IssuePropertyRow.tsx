import { cn } from '../lib/cn';
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { PrimaryButton } from './PrimaryButton';
import { IconButton } from './IconButton';
import { StatusDot } from './StatusDot';
import { PriorityIcon, type PriorityLevel } from './PriorityIcon';

export interface IssuePropertyStatus {
  id: string;
  name: string;
  color: string;
}

const priorityLabels: Record<PriorityLevel, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export interface IssuePropertyRowProps {
  statusId: string;
  priority: PriorityLevel | null;
  statuses: IssuePropertyStatus[];
  parentIssue?: { id: string; simpleId: string } | null;
  onParentIssueClick?: () => void;
  onRemoveParentIssue?: () => void;
  onStatusClick: () => void;
  onPriorityClick: () => void;
  onAddClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export function IssuePropertyRow({
  statusId,
  priority,
  statuses,
  parentIssue,
  onParentIssueClick,
  onRemoveParentIssue,
  onStatusClick,
  onPriorityClick,
  onAddClick,
  disabled,
  className,
}: IssuePropertyRowProps) {
  const { t } = useTranslation('common');

  return (
    <div className={cn('flex items-center gap-half flex-wrap', className)}>
      <PrimaryButton
        variant="tertiary"
        onClick={onStatusClick}
        disabled={disabled}
      >
        <StatusDot
          color={statuses.find((s) => s.id === statusId)?.color ?? '0 0% 50%'}
        />
        {statuses.find((s) => s.id === statusId)?.name ?? 'Select status'}
      </PrimaryButton>

      <PrimaryButton
        variant="tertiary"
        onClick={onPriorityClick}
        disabled={disabled}
      >
        <PriorityIcon priority={priority} />
        {priority ? priorityLabels[priority] : 'No priority'}
      </PrimaryButton>

      {parentIssue && (
        <div className="flex items-center gap-half">
          <PrimaryButton
            variant="tertiary"
            onClick={onParentIssueClick}
            disabled={disabled}
            className="whitespace-nowrap text-sm"
          >
            <span className="text-low">
              {t('kanban.parentIssue', 'Parent')}:
            </span>
            <span className="font-ibm-plex-mono text-normal">
              {parentIssue.simpleId}
            </span>
          </PrimaryButton>
          {onRemoveParentIssue && (
            <IconButton
              icon={XIcon}
              onClick={onRemoveParentIssue}
              disabled={disabled}
              aria-label="Remove parent issue"
              title="Remove parent issue"
            />
          )}
        </div>
      )}

      {onAddClick && (
        <IconButton
          icon={PlusIcon}
          onClick={onAddClick}
          disabled={disabled}
          aria-label="Add"
          title="Add"
        />
      )}
    </div>
  );
}
