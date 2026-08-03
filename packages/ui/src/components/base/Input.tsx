import * as React from "react";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "../../lib/utils.js";

export type InputProps = React.ComponentPropsWithoutRef<typeof BaseInput>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <BaseInput
        ref={ref}
        className={cn(
          "flex h-9 w-full rounded-md border border-db-border bg-db-elevated px-3 py-2 text-sm text-db-text shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "placeholder:text-db-text-tertiary",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-db-accent focus-visible:border-db-border-strong",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);

Input.displayName = "Input";
