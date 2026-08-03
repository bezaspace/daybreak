import * as React from "react";
import { Button, type ButtonProps } from "./Button.js";

export type IconButtonProps = Omit<ButtonProps, "size"> & {
  "aria-label": string;
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <Button ref={ref} size="icon" className={className} {...props}>
        {children}
      </Button>
    );
  },
);

IconButton.displayName = "IconButton";
