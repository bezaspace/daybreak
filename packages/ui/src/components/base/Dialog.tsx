import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "./Button.js";

export interface DialogProps extends BaseDialog.Root.Props {
  title?: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  trigger?: React.ReactNode;
}

export function Dialog({ title, description, children, footer, trigger, ...rootProps }: DialogProps) {
  return (
    <BaseDialog.Root {...rootProps}>
      {trigger && (
        <BaseDialog.Trigger
          render={(props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
            <Button {...props} variant="secondary">
              {trigger}
            </Button>
          )}
        />
      )}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
            "transition-opacity duration-150",
          )}
        />
        <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <BaseDialog.Popup
            className={cn(
              "w-full max-w-lg rounded-lg border border-db-border bg-db-surface p-6 shadow-xl",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "transition-all duration-150",
            )}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                {title && <BaseDialog.Title className="text-lg font-semibold text-db-text">{title}</BaseDialog.Title>}
                {description && (
                  <BaseDialog.Description className="mt-1 text-sm text-db-text-secondary">
                    {description}
                  </BaseDialog.Description>
                )}
              </div>
              <BaseDialog.Close
                render={(props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
                  <Button {...props} variant="ghost" size="icon" aria-label="Close">
                    <X className="h-4 w-4" />
                  </Button>
                )}
              />
            </div>
            <div className="text-sm text-db-text">{children}</div>
            {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
