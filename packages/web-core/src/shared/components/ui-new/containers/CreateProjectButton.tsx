import { PlusIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@vibe/ui/components/Tooltip';

interface CreateProjectButtonProps {
  onClick: () => void;
}

export function CreateProjectButton({ onClick }: CreateProjectButtonProps) {
  const { t } = useTranslation('common');
  const label = t('sidebar.createProject');
  return (
    <Tooltip content={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-haspopup="dialog"
        className={
          'flex size-6 items-center justify-center rounded-sm p-1 text-low ' +
          'hover:bg-tertiary hover:text-high transition-colors ' +
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        }
      >
        <PlusIcon className="size-icon-sm" weight="bold" />
      </button>
    </Tooltip>
  );
}
