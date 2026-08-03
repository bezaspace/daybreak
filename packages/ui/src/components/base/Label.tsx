import * as React from "react";
import { cn } from "../../lib/utils.js";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-sm font-medium text-db-text-secondary leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70", className)}
      {...props}
    />
  );
}
