import { ExternalLink } from "lucide-react";
import { Placeholder } from "./Placeholder.js";

interface Trace {
  traceUrl: string;
  trace?: Record<string, unknown>;
}

interface TraceTabProps {
  trace: Trace | null;
  loading: boolean;
}

export function TraceTab({ trace, loading }: TraceTabProps) {
  if (loading) return <Placeholder title="Trace">Loading…</Placeholder>;
  if (!trace?.traceUrl) return <Placeholder title="Trace">No trace for this session.</Placeholder>;

  return (
    <div className="h-full overflow-y-auto p-3 scrollbar-thin">
      <div className="space-y-2 text-sm">
        <a
          href={trace.traceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-db-accent hover:underline"
        >
          Open in Langfuse <ExternalLink className="h-3 w-3" />
        </a>
        {trace.trace && (
          <pre className="max-h-96 overflow-auto rounded border border-db-border bg-db-elevated p-2 text-xs text-db-text-secondary scrollbar-thin">
            {JSON.stringify(trace.trace, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
