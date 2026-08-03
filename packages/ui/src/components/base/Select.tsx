import * as React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectProps = BaseSelect.Root.Props<string, false> & {
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  className?: string;
};

export function Select({ options, placeholder = "Select an option…", label, className, children, ...rootProps }: SelectProps) {
  return (
    <BaseSelect.Root {...rootProps}>
      {label && (
        <BaseSelect.Label className="mb-1 block text-sm font-medium text-db-text-secondary">{label}</BaseSelect.Label>
      )}
      <BaseSelect.Trigger
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-db-border bg-db-elevated px-3 py-2 text-sm text-db-text shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-db-accent focus-visible:border-db-border-strong",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <BaseSelect.Value placeholder={placeholder} className="truncate" />
        <BaseSelect.Icon className="text-db-text-tertiary">
          <ChevronDown className="h-4 w-4" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner alignItemWithTrigger={false} className="z-50" sideOffset={4}>
          <BaseSelect.Popup
            className={cn(
              "max-h-60 w-[var(--select-popup-width)] overflow-y-auto rounded-md border border-db-border bg-db-surface py-1 shadow-lg",
              "focus-visible:outline-none",
            )}
          >
            <BaseSelect.ScrollUpArrow className="flex h-4 items-center justify-center text-db-text-tertiary" />
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cn(
                    "relative flex cursor-pointer select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm text-db-text outline-none",
                    "data-[highlighted]:bg-db-subtle data-[selected]:bg-db-accent/10 data-[selected]:text-db-accent",
                    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                  )}
                >
                  <BaseSelect.ItemText className="truncate">{option.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="ml-2 text-db-accent">
                    <Check className="h-4 w-4" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
            <BaseSelect.ScrollDownArrow className="flex h-4 items-center justify-center text-db-text-tertiary" />
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
