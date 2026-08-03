import * as React from "react";
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "../../lib/utils.js";
import { Button } from "./Button.js";

export interface AlertDialogProps extends BaseAlertDialog.Root.Props {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  children?: React.ReactNode;
}

export function AlertDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  children,
  ...rootProps
}: AlertDialogProps) {
  return (
    <BaseAlertDialog.Root {...rootProps}>
      {children}
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/70 backdrop-blur-sm",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
            "transition-opacity duration-150",
          )}
        />
        <BaseAlertDialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <BaseAlertDialog.Popup
            className={cn(
              "w-full max-w-md rounded-lg border border-db-border bg-db-surface p-6 shadow-xl",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "transition-all duration-150",
            )}
          >
            <BaseAlertDialog.Title className="text-lg font-semibold text-db-text">{title}</BaseAlertDialog.Title>
            {description && (
              <BaseAlertDialog.Description className="mt-2 text-sm text-db-text-secondary">
                {description}
              </BaseAlertDialog.Description>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <BaseAlertDialog.Close
                render={(props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
                  <Button {...props} variant="ghost">
                    {cancelLabel}
                  </Button>
                )}
              />
              <BaseAlertDialog.Close
                render={(props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
                  <Button {...props} variant="danger" onClick={onConfirm}>
                    {confirmLabel}
                  </Button>
                )}
              />
            </div>
          </BaseAlertDialog.Popup>
        </BaseAlertDialog.Viewport>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
