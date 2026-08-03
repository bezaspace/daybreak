import * as React from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { cn } from "../../lib/utils.js";

export type ButtonProps = React.ComponentPropsWithoutRef<typeof BaseButton> & {
  variant?: "default" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", children, ...props }, ref) => {
    return (
      <BaseButton
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-md font-medium text-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-db-accent focus-visible:ring-offset-2 focus-visible:ring-offset-db-page",
          "disabled:pointer-events-none disabled:opacity-50",
          {
            "bg-db-accent text-white hover:bg-db-accent-hover": variant === "default",
            "bg-db-elevated text-db-text border border-db-border hover:bg-db-subtle hover:border-db-border-strong": variant === "secondary",
            "border border-db-border bg-transparent text-db-text hover:bg-db-elevated hover:border-db-border-strong": variant === "outline",
            "text-db-text-secondary hover:bg-db-elevated hover:text-db-text": variant === "ghost",
            "bg-db-danger text-white hover:opacity-90": variant === "danger",
          },
          {
            "h-7 px-2 text-xs": size === "sm",
            "h-9 px-3": size === "md",
            "h-10 px-4 text-base": size === "lg",
            "h-8 w-8 p-0": size === "icon",
          },
          className,
        )}
        {...props}
      >
        {children}
      </BaseButton>
    );
  },
);

Button.displayName = "Button";
