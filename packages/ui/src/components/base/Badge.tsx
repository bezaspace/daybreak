import * as React from "react";
import { cn } from "../../lib/utils.js";

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "success" | "warning" | "danger" | "info" | "secondary";
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        {
          "bg-db-accent/10 text-db-accent border border-db-accent/20": variant === "default",
          "bg-db-success/10 text-db-success border border-db-success/20": variant === "success",
          "bg-db-warning/10 text-db-warning border border-db-warning/20": variant === "warning",
          "bg-db-danger/10 text-db-danger border border-db-danger/20": variant === "danger",
          "bg-db-info/10 text-db-info border border-db-info/20": variant === "info",
          "bg-db-elevated text-db-text-secondary border border-db-border": variant === "secondary",
        },
        className,
      )}
      {...props}
    />
  );
}
