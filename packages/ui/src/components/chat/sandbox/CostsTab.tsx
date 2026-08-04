import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Placeholder } from "./Placeholder.js";
import { formatCost } from "../../../lib/format.js";
import type { TaskMetrics } from "../../../lib/types.js";

interface CostsTabProps {
  costAlert: { current: number; limit: number; threshold: number } | null;
  metrics: TaskMetrics | null;
  costData: { label: string; cost: number; turns: number }[];
}

export function CostsTab({ costAlert, metrics, costData }: CostsTabProps) {
  return (
    <div className="h-full overflow-y-auto p-3 scrollbar-thin">
      {costAlert && (
        <div className="mb-3 rounded border border-db-warning/30 bg-db-warning/5 p-2 text-xs text-db-warning">
          Cost alert: {formatCost(costAlert.current)} / {formatCost(costAlert.limit)} (threshold {costAlert.threshold})
        </div>
      )}
      {metrics && (
        <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-db-text-secondary">
          <div className="rounded border border-db-border bg-db-elevated p-2">
            <div className="text-db-text-tertiary">Turns</div>
            <div className="text-lg font-medium text-db-text">{metrics.turns ?? "-"}</div>
          </div>
          <div className="rounded border border-db-border bg-db-elevated p-2">
            <div className="text-db-text-tertiary">Cost</div>
            <div className="text-lg font-medium text-db-text">{formatCost(metrics.estimatedCostUsd)}</div>
          </div>
          <div className="rounded border border-db-border bg-db-elevated p-2">
            <div className="text-db-text-tertiary">Tool calls</div>
            <div className="text-lg font-medium text-db-text">{metrics.toolCalls ?? "-"}</div>
          </div>
          <div className="rounded border border-db-border bg-db-elevated p-2">
            <div className="text-db-text-tertiary">Tokens</div>
            <div className="text-lg font-medium text-db-text">{metrics.totalTokens ?? "-"}</div>
          </div>
        </div>
      )}
      {costData.length > 0 ? (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={costData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="label" tick={{ fill: "#9ca3af", fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis yAxisId="left" tick={{ fill: "#9ca3af", fontSize: 10 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fill: "#9ca3af", fontSize: 10 }} />
              <Tooltip
                contentStyle={{ backgroundColor: "#1f2937", borderColor: "#374151" }}
                itemStyle={{ color: "#e5e7eb" }}
              />
              <Legend wrapperStyle={{ color: "#9ca3af" }} />
              <Line yAxisId="left" type="monotone" dataKey="cost" name="Cost (USD)" stroke="#22c55e" dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="turns" name="Turns" stroke="#3b82f6" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Placeholder title="Costs">No cost data for this session.</Placeholder>
      )}
    </div>
  );
}
