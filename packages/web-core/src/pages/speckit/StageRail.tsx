import {
  CheckCircleIcon,
  CircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import type { SpecKitStage, SpecKitStageState } from 'shared/types';
import { STAGES, type StageMeta } from './stages';

interface StageRailProps {
  selected: SpecKitStage;
  onSelect: (stage: SpecKitStage) => void;
  stateFor: (stage: SpecKitStage) => SpecKitStageState;
}

function StageIcon({ state }: { state: SpecKitStageState }) {
  switch (state) {
    case 'running':
      return (
        <CircleNotchIcon className="size-icon-sm animate-spin text-brand" />
      );
    case 'done':
      return (
        <CheckCircleIcon className="size-icon-sm text-success" weight="fill" />
      );
    case 'needs_attention':
      return (
        <WarningCircleIcon className="size-icon-sm text-error" weight="fill" />
      );
    default:
      return <CircleIcon className="size-icon-sm text-low" />;
  }
}

export function StageRail({ selected, onSelect, stateFor }: StageRailProps) {
  return (
    <nav className="flex w-56 shrink-0 flex-col gap-half border-r p-base">
      <div className="px-half pb-half text-xs font-medium uppercase tracking-wide text-low">
        SpecKit stages
      </div>
      {STAGES.map((meta: StageMeta) => {
        const active = meta.stage === selected;
        return (
          <button
            key={meta.stage}
            type="button"
            onClick={() => onSelect(meta.stage)}
            className={`flex items-start gap-half rounded-sm px-half py-half text-left transition-colors ${
              active ? 'bg-panel text-high' : 'text-normal hover:bg-panel/50'
            }`}
          >
            <span className="mt-px">
              <StageIcon state={stateFor(meta.stage)} />
            </span>
            <span className="flex flex-col">
              <span className="text-sm font-medium">{meta.label}</span>
              <span className="text-xs text-low">{meta.blurb}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
