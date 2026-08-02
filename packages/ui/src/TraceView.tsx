import { useEffect, useState } from "react";

interface Observation {
  id: string;
  name: string;
  type?: string;
  parentObservationId?: string | null;
  startTime?: string;
  endTime?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    totalCost?: number;
    cost?: number;
  };
  metadata?: Record<string, unknown>;
  calculatedTotalCost?: number;
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface ObservationNode extends Observation {
  children: ObservationNode[];
}

interface TraceData {
  id: string;
  name?: string;
  timestamp?: string;
  observations?: Observation[];
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface TraceResponse {
  trace: TraceData;
  traceUrl: string;
}

interface TraceViewProps {
  taskId: string;
  traceId?: string;
  provider?: string;
  costUsd?: number;
}

function getObservationCost(obs: Observation): number | undefined {
  return obs.usage?.totalCost ?? obs.usage?.cost ?? obs.calculatedTotalCost ?? obs.totalCost;
}

function getObservationTokens(obs: Observation): { input?: number; output?: number; total?: number } {
  return {
    input: obs.usage?.input ?? obs.inputTokens,
    output: obs.usage?.output ?? obs.outputTokens,
    total: obs.usage?.total ?? obs.totalTokens,
  };
}

function getObservationModel(obs: Observation): string | undefined {
  return obs.model ?? (obs.metadata as { "gen_ai.request.model"?: string } | undefined)?.["gen_ai.request.model"];
}

function getObservationProvider(obs: Observation): string | undefined {
  return (obs.metadata as { "gen_ai.provider.name"?: string } | undefined)?.["gen_ai.provider.name"];
}

function formatDuration(start?: string, end?: string): string {
  if (!start || !end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function colorForName(name: string, type?: string): string {
  if (type === "GENERATION" || name === "llm") return "#2563eb";
  if (name.startsWith("tool:")) return "#ea580c";
  if (name === "turn") return "#16a34a";
  if (name === "compaction") return "#9333ea";
  return "#6b7280";
}

function buildTree(observations: Observation[]): ObservationNode[] {
  const map = new Map<string, ObservationNode>();
  const roots: ObservationNode[] = [];

  for (const obs of observations) {
    map.set(obs.id, { ...obs, children: [] });
  }

  for (const obs of observations) {
    const node = map.get(obs.id);
    if (!node) continue;
    if (obs.parentObservationId && map.has(obs.parentObservationId)) {
      map.get(obs.parentObservationId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function ObservationRow({ node, depth }: { node: ObservationNode; depth: number }) {
  const tokens = getObservationTokens(node);
  const cost = getObservationCost(node);
  const model = getObservationModel(node);
  const provider = getObservationProvider(node);

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div
        style={{
          borderLeft: `3px solid ${colorForName(node.name, node.type)}`,
          paddingLeft: 8,
          margin: "4px 0",
        }}
      >
        <div style={{ fontWeight: 600 }}>
          {node.name} {node.type ? `(${node.type})` : ""}
        </div>
        <div style={{ color: "#666", fontSize: 12 }}>
          {model ? `model: ${model}` : ""}
          {provider ? ` · provider: ${provider}` : ""}
          {` · latency: ${formatDuration(node.startTime, node.endTime)}`}
          {tokens.total !== undefined && ` · tokens: ${tokens.input ?? 0}/${tokens.output ?? 0}/${tokens.total}`}
          {typeof cost === "number" && ` · cost: $${cost.toFixed(6)}`}
        </div>
        {node.metadata && Object.keys(node.metadata).length > 0 && (
          <details>
            <summary style={{ fontSize: 12, color: "#666" }}>metadata</summary>
            <pre
              style={{
                fontSize: 11,
                maxHeight: 120,
                overflow: "auto",
                background: "#f6f6f6",
                padding: 4,
              }}
            >
              {JSON.stringify(node.metadata, null, 2)}
            </pre>
          </details>
        )}
      </div>
      {node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <ObservationRow key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TraceView({ taskId, traceId, provider, costUsd }: TraceViewProps) {
  const [response, setResponse] = useState<TraceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/tasks/${taskId}/trace`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<TraceResponse>;
      })
      .then(setResponse)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [taskId]);

  if (loading) return <div>Loading trace...</div>;
  if (error) return <div style={{ color: "red" }}>Trace error: {error}</div>;
  if (!response?.trace) return <div>No trace data</div>;

  const trace = response.trace;
  const observations = trace.observations || [];
  const tree = buildTree(observations);

  return (
    <div>
      <h2>Trace</h2>
      <div style={{ marginBottom: "1rem" }}>
        <code>{traceId}</code>
        {provider ? ` · provider: ${provider}` : ""}
        {costUsd !== undefined ? ` · cost: $${costUsd.toFixed(4)}` : ""}
        {typeof trace.totalCost === "number" ? ` · Langfuse cost: $${trace.totalCost.toFixed(4)}` : ""}
        {" · "}
        <a href={response.traceUrl} target="_blank" rel="noopener noreferrer">
          Open in Langfuse
        </a>
      </div>
      {tree.map((node) => (
        <ObservationRow key={node.id} node={node} depth={0} />
      ))}
    </div>
  );
}
