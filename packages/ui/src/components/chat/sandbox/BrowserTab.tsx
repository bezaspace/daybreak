import { Placeholder } from "./Placeholder.js";
import type { Screenshot } from "../../../lib/types.js";

interface BrowserTabProps {
  screenshots: Screenshot[];
  latestScreenshot?: Screenshot;
}

export function BrowserTab({ screenshots, latestScreenshot }: BrowserTabProps) {
  if (screenshots.length === 0) {
    return <Placeholder title="Browser">No screenshots yet.</Placeholder>;
  }

  return (
    <div className="h-full overflow-y-auto p-3 scrollbar-thin">
      <div className="space-y-3">
        {latestScreenshot?.url && (
          <div className="text-xs text-db-text-tertiary">
            URL:{" "}
            <a
              href={latestScreenshot.url}
              target="_blank"
              rel="noreferrer"
              className="text-db-accent hover:underline"
            >
              {latestScreenshot.url}
            </a>
          </div>
        )}
        {screenshots.map((s, i) => (
          <div key={i}>
            <img
              src={s.dataUrl}
              alt={s.url ? `Screenshot ${i + 1} of ${s.url}` : `Screenshot ${i + 1}`}
              className="w-full rounded border border-db-border"
            />
            <div className="mt-1 text-xs text-db-text-tertiary">{s.url || "Browser screenshot"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
