import {
  BuildingsIcon,
  GearIcon,
  SignInIcon,
  SignOutIcon,
  UserIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from './Dropdown';

export interface AppBarUserOrganization {
  id: string;
  name: string;
}

interface AppBarUserPopoverProps {
  isSignedIn: boolean;
  avatarUrl: string | null;
  avatarError: boolean;
  organizations: AppBarUserOrganization[];
  selectedOrgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOrgSelect: (orgId: string) => void;
  onOrgSettings?: (orgId: string) => void;
  onSettings?: () => void;
  onSignIn: () => void;
  // Optional: render a "Sign out" item. The local-only indie app has nothing
  // to sign out of and typically omits this; pass it when you need a logout
  // entry in the popover.
  onLogout?: () => void;
  onAvatarError: () => void;
}

export function AppBarUserPopover({
  isSignedIn,
  avatarUrl,
  avatarError,
  organizations,
  selectedOrgId,
  open,
  onOpenChange,
  onOrgSelect: _onOrgSelect,
  onOrgSettings: _onOrgSettings,
  onSettings,
  onSignIn,
  onLogout,
  onAvatarError,
}: AppBarUserPopoverProps) {
  const { t } = useTranslation();
  const settingsLabel = t('settings:settings.layout.nav.title', {
    defaultValue: 'Settings',
  });
  const selectedOrg =
    organizations.find((org) => org.id === selectedOrgId) ?? organizations[0];

  if (!isSignedIn) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center justify-center w-7 h-7 sm:w-10 sm:h-10 rounded-md sm:rounded-lg',
              'bg-panel text-normal font-medium text-sm',
              'transition-colors cursor-pointer',
              'hover:bg-panel/70',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand'
            )}
            aria-label="Sign in"
          >
            <UserIcon className="size-icon-sm" weight="bold" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="min-w-[200px]">
          <DropdownMenuItem icon={SignInIcon} onClick={onSignIn}>
            {t('signIn')}
          </DropdownMenuItem>
          {onSettings && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={GearIcon} onClick={onSettings}>
                {settingsLabel}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center justify-center w-7 h-7 sm:w-10 sm:h-10 rounded-md sm:rounded-lg',
            'transition-colors cursor-pointer overflow-hidden',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            (!avatarUrl || avatarError) &&
              'bg-panel text-normal font-medium text-sm',
            (!avatarUrl || avatarError) && 'hover:bg-panel/70'
          )}
          aria-label="Account"
        >
          {avatarUrl && !avatarError ? (
            <img
              src={avatarUrl}
              alt="User avatar"
              className="w-full h-full object-cover"
              onError={onAvatarError}
            />
          ) : (
            <UserIcon className="size-icon-sm" weight="bold" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="min-w-[200px]">
        <DropdownMenuLabel>{t('orgSwitcher.organizations')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {selectedOrg && (
          <div className="px-3 py-2 text-sm text-fg-muted flex items-center gap-2">
            <BuildingsIcon className="size-icon-xs" weight="bold" />
            <span className="truncate">{selectedOrg.name}</span>
          </div>
        )}
        {onSettings && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={GearIcon} onClick={onSettings}>
              {settingsLabel}
            </DropdownMenuItem>
          </>
        )}
        {onLogout && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={SignOutIcon} onClick={onLogout}>
              {t('signOut')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
