import { useMemo, useState } from 'react';
import { BuildingsIcon, CheckIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { OrganizationWithRole } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { useUserOrganizations } from '@/shared/hooks/useUserOrganizations';
import {
  useOrganizationStore,
  useSelectedOrgId,
} from '@/shared/stores/useOrganizationStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/Dropdown';
import { Tooltip } from '@vibe/ui/components/Tooltip';

interface OrganizationSwitcherButtonProps {
  /** Override organizations; falls back to useUserOrganizations(). */
  organizations?: OrganizationWithRole[];
}

/**
 * Compact org switcher intended for the bottom row of the left Sidebar.
 * Renders a tooltip-wrapped button showing the current org's name (or a
 * generic label when none is selected). The dropdown lists all orgs and
 * switches via {@link useOrganizationStore.setSelectedOrgId}.
 *
 * Built rather than extracted because the existing `AppBarUserPopover`
 * didn't host a real switcher — it only showed the selected org as a
 * static label. Centralising the switching here keeps `AppBarUserPopover`
 * focused on account actions.
 */
export function OrganizationSwitcherButton({
  organizations: organizationsOverride,
}: OrganizationSwitcherButtonProps = {}) {
  const { t } = useTranslation('common');
  const { data: orgsData } = useUserOrganizations();
  const organizations = useMemo<OrganizationWithRole[]>(
    () => organizationsOverride ?? orgsData?.organizations ?? [],
    [organizationsOverride, orgsData?.organizations]
  );

  const selectedOrgId = useSelectedOrgId();
  const setSelectedOrgId = useOrganizationStore((s) => s.setSelectedOrgId);
  const [open, setOpen] = useState(false);

  const selectedOrg = useMemo<OrganizationWithRole | null>(() => {
    if (!selectedOrgId || organizations.length === 0) return null;
    return organizations.find((o) => o.id === selectedOrgId) ?? null;
  }, [selectedOrgId, organizations]);

  // No orgs — render nothing rather than a dead button.
  if (organizations.length === 0) return null;

  const label = selectedOrg?.name ?? t('appBar.organizations');

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip content={t('appBar.organizations')} side="right">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('appBar.organizations')}
            className={cn(
              'flex items-center gap-1 rounded-md px-1.5 py-1',
              'text-xs text-normal hover:bg-tertiary cursor-pointer transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand'
            )}
          >
            <BuildingsIcon className="size-icon-2xs" weight="bold" />
            <span className="max-w-[8rem] truncate">{label}</span>
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" className="min-w-[200px]">
        <DropdownMenuLabel>{t('appBar.organizations')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {organizations.map((org) => {
          const isActive = org.id === selectedOrgId;
          return (
            <DropdownMenuItem
              key={org.id}
              icon={isActive ? CheckIcon : BuildingsIcon}
              onClick={() => {
                setSelectedOrgId(org.id);
                setOpen(false);
              }}
            >
              <span className="truncate">{org.name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}