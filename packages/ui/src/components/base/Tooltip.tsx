import * as React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "../../lib/utils.js";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
}

export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  return (
    <BaseTooltip.Provider>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger
          render={(props: React.HTMLAttributes<HTMLElement>) => (
            <span {...props} className={cn("inline-flex", props.className)}>
              {children}
            </span>
          )}
        />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={6}>
            <BaseTooltip.Popup
              className={cn(
                "z-50 rounded-md border border-db-border bg-db-elevated px-2 py-1 text-xs text-db-text shadow-lg",
                "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
                "transition-opacity duration-100",
              )}
            >
              <BaseTooltip.Viewport>{content}</BaseTooltip.Viewport>
              <BaseTooltip.Arrow className="fill-db-elevated text-db-elevated stroke-db-border" />
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
