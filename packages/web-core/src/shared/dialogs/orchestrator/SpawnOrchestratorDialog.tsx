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
import { Checkbox } from '@vibe/ui/components/Checkbox';
import { Label } from '@vibe/ui/components/Label';
import { Input } from '@vibe/ui/components/Input';
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';
import { workspacesApi } from '@/shared/lib/api';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import {
  ORCHESTRATOR_DIRECTIVES,
  composeOrchestratorPrompt,
  loadDirectiveState,
  saveDirectiveState,
} from '@/shared/lib/orchestrator/orchestratorOptions';

export interface SpawnOrchestratorDialogProps {}

const SpawnOrchestratorDialogImpl = create<SpawnOrchestratorDialogProps>(() => {
  const modal = useModal();
  const appNavigation = useAppNavigation();
  const { t } = useTranslation('tasks');
  const queryClient = useQueryClient();

  const [name, setName] = useState('Orchestrator');
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    loadDirectiveState()
  );

  useEffect(() => {
    if (!modal.visible) {
      setName('Orchestrator');
      setEnabled(loadDirectiveState());
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

  const enabledIds = useMemo(
    () => new Set(Object.keys(enabled).filter((id) => enabled[id])),
    [enabled]
  );

  const toggleDirective = (id: string, checked: boolean) => {
    setEnabled((prev) => {
      const next = { ...prev, [id]: checked };
      saveDirectiveState(next);
      return next;
    });
  };

  const spawnMutation = useMutation({
    mutationFn: async () => {
      return workspacesApi.spawnOrchestrator({
        prompt: composeOrchestratorPrompt(enabledIds),
        name: name.trim() || 'Orchestrator',
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      modal.hide();
      if (data.workspace) appNavigation.goToWorkspace(data.workspace.id);
    },
  });

  const handleOpenChange = (open: boolean) => {
    if (!open) modal.hide();
  };

  const openRunning = () => {
    if (!runningOrchestrator) return;
    modal.hide();
    appNavigation.goToWorkspace(runningOrchestrator.id);
  };

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

          <div className="space-y-3">
            <Label>{t('spawnOrchestrator.directivesLabel')}</Label>
            {ORCHESTRATOR_DIRECTIVES.map((directive) => (
              <div key={directive.id} className="flex items-start gap-2">
                <Checkbox
                  id={`orchestrator-directive-${directive.id}`}
                  checked={!!enabled[directive.id]}
                  onCheckedChange={(checked) =>
                    toggleDirective(directive.id, checked === true)
                  }
                  disabled={!!runningOrchestrator}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label
                    htmlFor={`orchestrator-directive-${directive.id}`}
                    className="font-normal"
                  >
                    {t(directive.labelKey)}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t(directive.descriptionKey)}
                  </p>
                </div>
              </div>
            ))}
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
            disabled={spawnMutation.isPending}
          >
            {t('common:buttons.cancel')}
          </Button>
          {runningOrchestrator ? (
            <Button onClick={openRunning}>
              {t('spawnOrchestrator.openRunning')}
            </Button>
          ) : (
            <Button
              onClick={() => spawnMutation.mutate()}
              disabled={spawnMutation.isPending}
            >
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
