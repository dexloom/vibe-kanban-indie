import { useCallback } from 'react';
import { RoutinesPanel } from '@/features/recurrent/ui/RoutinesPanel';
import { useSettingsDirty } from './SettingsDirtyContext';

export function RecurrentSettingsSection({
  onClose,
}: {
  onClose?: () => void;
}) {
  const { setDirty: setContextDirty } = useSettingsDirty();

  const handleDirtyChange = useCallback(
    (dirty: boolean) => setContextDirty('recurrent', dirty),
    [setContextDirty]
  );

  return (
    <RoutinesPanel onDirtyChange={handleDirtyChange} onOpenRun={onClose} />
  );
}
