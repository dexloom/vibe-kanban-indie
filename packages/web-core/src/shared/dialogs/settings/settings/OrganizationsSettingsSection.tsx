import { useTranslation } from 'react-i18next';

export function OrganizationsSettingsSection() {
  const { t } = useTranslation('organization');

  return (
    <div className="space-y-base">
      <p className="text-sm text-normal">
        {t(
          'singleUser.description',
          'This installation runs as a single-user local fork.'
        )}
      </p>
      <div className="rounded border p-base bg-secondary">
        <p className="text-sm font-medium text-high">Local</p>
        <p className="mt-half text-xs text-low">
          {t('singleUser.noTeamManagement', 'Single-user, no team management.')}
        </p>
      </div>
    </div>
  );
}
