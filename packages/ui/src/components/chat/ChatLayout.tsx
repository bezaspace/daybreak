import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

interface ChatLayoutProps {
  left: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function ChatLayout({ left, center, right, className }: ChatLayoutProps) {
  return (
    <div className={cn("flex h-full w-full overflow-hidden bg-db-page", className)}>
      {left}
      <main className="flex min-w-0 flex-1 flex-col">{center}</main>
      {right}
    </div>
  );
}
