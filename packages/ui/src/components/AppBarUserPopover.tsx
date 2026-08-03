import {
  GearIcon,
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
  avatarUrl: string | null;
  avatarError: boolean;
  organizations: AppBarUserOrganization[];
  selectedOrgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettings?: () => void;
  // Optional: render a "Sign out" item. The local-only indie app has nothing
  // to sign out of and typically omits this; pass it when you need a logout
  // entry in the popover.
  onLogout?: () => void;
  onAvatarError: () => void;
}

export function AppBarUserPopover({
  avatarUrl,
  avatarError,
  open,
  onOpenChange,
  onSettings,
  onLogout,
  onAvatarError,
}: AppBarUserPopoverProps) {
  const { t } = useTranslation();
  const settingsLabel = t('settings:settings.layout.nav.title', {
    defaultValue: 'Settings',
  });

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
