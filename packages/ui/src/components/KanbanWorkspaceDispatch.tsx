import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PlayIcon } from "@phosphor-icons/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./Select";
import { cn } from "../lib/cn";

export interface DispatchWorkspaceOption {
  id: string;
  name: string | null;
}

export interface KanbanWorkspaceDispatchProps {
  workspaces: DispatchWorkspaceOption[];
  disabled?: boolean;
  onDispatch: (workspaceId: string) => void;
  className?: string;
}

/**
 * Compact per-card dispatch control: pick one of the existing workspaces from
 * a dropdown and press play to run this issue in that workspace's session
 * (dispatches via `POST /api/issues/{id}/dispatch-to-workspace`). Disabled
 * when there are no workspaces to choose from.
 */
export function KanbanWorkspaceDispatch({
  workspaces,
  disabled,
  onDispatch,
  className,
}: KanbanWorkspaceDispatchProps) {
  const { t } = useTranslation("common");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const value = selectedId ?? workspaces[0]?.id;
  const empty = workspaces.length === 0;

  return (
    <div
      className={cn("flex items-center gap-half min-w-0", className)}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <Select
        value={value}
        onValueChange={setSelectedId}
        disabled={disabled || empty}
      >
        <SelectTrigger
          className="h-6 min-w-0 flex-1 rounded-sm border-0 bg-secondary/60 px-1.5 py-0 text-xs data-[placeholder]:text-low"
          aria-label={t("kanban.selectWorkspace")}
        >
          <SelectValue placeholder={t("kanban.selectWorkspace")} />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name ?? workspace.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="button"
        disabled={disabled || empty || !value}
        onClick={() => value && onDispatch(value)}
        className="rounded p-half -m-half shrink-0 text-low transition-colors hover:bg-secondary hover:text-normal disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={t("kanban.dispatchIssue")}
        title={t("kanban.dispatchIssue")}
      >
        <PlayIcon className="size-icon-xs" weight="fill" />
      </button>
    </div>
  );
}
