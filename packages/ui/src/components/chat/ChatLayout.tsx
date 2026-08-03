import { useEffect, useState, type ReactNode } from "react";
import { PanelLeft, PanelRightOpen, X } from "lucide-react";
import { cn } from "../../lib/utils.js";

interface ChatLayoutProps {
  left: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function ChatLayout({ left, center, right, className }: ChatLayoutProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileRightOpen, setMobileRightOpen] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 768px)");
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return (
    <div className={cn("flex h-full w-full overflow-hidden bg-db-page", className)}>
      <div className="hidden h-full shrink-0 md:flex">{left}</div>

      {isMobile && mobileSidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 w-64 max-w-[80vw]">{left}</div>
        </>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {isMobile && (
          <div className="flex h-12 items-center justify-between border-b border-db-border bg-db-surface px-3 md:hidden">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="rounded p-2 text-db-text-secondary hover:bg-db-subtle"
              aria-label="Open sidebar"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold text-db-text">Daybreak</span>
            {right && (
              <button
                type="button"
                onClick={() => setMobileRightOpen(true)}
                className="rounded p-2 text-db-text-secondary hover:bg-db-subtle"
                aria-label="Open panel"
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
        {center}
      </main>

      <div className="hidden h-full shrink-0 md:flex">{right}</div>

      {isMobile && right && mobileRightOpen && (
        <div className="fixed inset-x-0 bottom-0 z-50 h-1/2 border-t border-db-border bg-db-surface">
          <div className="flex h-10 items-center justify-between border-b border-db-border px-3">
            <span className="text-sm font-semibold text-db-text">Sandbox</span>
            <button
              type="button"
              onClick={() => setMobileRightOpen(false)}
              className="rounded p-1 text-db-text-secondary hover:bg-db-subtle"
              aria-label="Close panel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="h-[calc(50vh-2.5rem)] overflow-hidden">{right}</div>
        </div>
      )}
    </div>
  );
}
