import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

interface CheckboxProps {
  id?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
  disabled?: boolean;
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    { className, checked = false, onCheckedChange, disabled, ...props },
    ref
  ) => {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        ref={ref}
        className={cn(
          'peer h-4 w-4 shrink-0 rounded-sm border border-primary-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          // `bg-primary` resolves to the app's main background (dark grey),
          // so a checked box used to read as an empty grey square. Use the
          // foreground/background pair instead: a clearly white fill with a
          // contrasting checkmark, so the checked state is unambiguous.
          checked
            ? 'bg-foreground text-background border-foreground'
            : 'border-primary-foreground',
          className
        )}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
        {...props}
      >
        {checked && (
          <div className="flex items-center justify-center text-current">
            <Check className="h-4 w-4" />
          </div>
        )}
      </button>
    );
  }
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
