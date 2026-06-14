import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RobotIcon } from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { Label } from '@vibe/ui/components/Label';
import { Input } from '@vibe/ui/components/Input';
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';
import { workspacesApi } from '@/shared/lib/api';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { composeOrchestratorPrompt } from '@/shared/lib/orchestrator/orchestratorOptions';

export interface SpawnOrchestratorDialogProps {}

const SpawnOrchestratorDialogImpl = create<SpawnOrchestratorDialogProps>(() => {
  const modal = useModal();
  const appNavigation = useAppNavigation();
  const { t } = useTranslation('tasks');
  const queryClient = useQueryClient();

  const [name, setName] = useState('Orchestrator');

  useEffect(() => {
    if (!modal.visible) {
      setName('Orchestrator');
    }
  }, [modal.visible]);

  // The orchestrator is a singleton; detect a live one so we can offer to open
  // it instead of spawning. The backend enforces the singleton regardless.
  const { workspaces } = useWorkspaces();
  const runningOrchestrator = useMemo(
    () =>
      workspaces.find(
        (ws) =>
          ws.kind === 'orchestrator' &&
          !ws.isArchived &&
          (ws.isRunning || ws.latestProcessStatus === 'running')
      ) ?? null,
    [workspaces]
  );

  const spawnMutation = useMutation({
    mutationFn: async () => {
      return workspacesApi.spawnOrchestrator({
        prompt: composeOrchestratorPrompt(),
        name: name.trim() || 'Orchestrator',
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      modal.hide();
      if (data.workspace) appNavigation.goToWorkspace(data.workspace.id);
    },
  });

  const closeMutation = useMutation({
    mutationFn: async () => workspacesApi.closeOrchestrator(),
    onSuccess: () => {
      // Refetching flips the dialog back to the spawn form once the now-closed
      // orchestrator stops reporting as running.
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
    },
  });

  const busy = spawnMutation.isPending || closeMutation.isPending;

  const handleOpenChange = (open: boolean) => {
    if (!open) modal.hide();
  };

  // Route "open" through the spawn endpoint so the backend decides reuse vs.
  // respawn: a genuinely live session is reused, a dead one (tmux gone) is
  // transparently replaced with a fresh session.
  const openRunning = () => spawnMutation.mutate();

  return (
    <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RobotIcon className="size-5" weight="fill" />
            {t('spawnOrchestrator.title')}
          </DialogTitle>
          <DialogDescription>
            {t('spawnOrchestrator.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {runningOrchestrator && (
            <div className="rounded-md border border-border bg-secondary/50 p-3 text-sm text-normal">
              {t('spawnOrchestrator.existingRunning')}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="orchestrator-name">
              {t('spawnOrchestrator.nameLabel')}
            </Label>
            <Input
              id="orchestrator-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!!runningOrchestrator}
            />
          </div>

          {spawnMutation.error && (
            <div className="text-sm text-destructive">
              {spawnMutation.error instanceof Error
                ? spawnMutation.error.message
                : String(spawnMutation.error)}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => modal.hide()}
            disabled={busy}
          >
            {t('common:buttons.cancel')}
          </Button>
          {runningOrchestrator ? (
            <>
              <Button
                variant="destructive"
                onClick={() => closeMutation.mutate()}
                disabled={busy}
              >
                {closeMutation.isPending
                  ? t('spawnOrchestrator.closing')
                  : t('spawnOrchestrator.close')}
              </Button>
              <Button onClick={openRunning} disabled={busy}>
                {spawnMutation.isPending
                  ? t('spawnOrchestrator.spawning')
                  : t('spawnOrchestrator.openRunning')}
              </Button>
            </>
          ) : (
            <Button onClick={() => spawnMutation.mutate()} disabled={busy}>
              {spawnMutation.isPending
                ? t('spawnOrchestrator.spawning')
                : t('spawnOrchestrator.spawn')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const SpawnOrchestratorDialog = defineModal<
  SpawnOrchestratorDialogProps,
  void
>(SpawnOrchestratorDialogImpl);
