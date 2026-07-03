import { useTranslation } from 'react-i18next';
import { RoutinesPanel } from '@/features/recurrent/ui/RoutinesPanel';

export function CommonTasksPage() {
  const { t } = useTranslation('settings');

  return (
    <div className="h-full overflow-auto bg-primary">
      <div className="mx-auto w-full max-w-3xl px-base py-double space-y-double">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold text-high">
            {t('settings.recurrent.page.title')}
          </h1>
          <p className="text-sm text-low">
            {t('settings.recurrent.page.description')}
          </p>
        </header>
        <RoutinesPanel management />
      </div>
    </div>
  );
}

export function CommonTasksPageContainer() {
  return <CommonTasksPage />;
}
