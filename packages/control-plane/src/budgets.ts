import { loadConfig } from "@daybreak/shared";
import { getSupabase } from "./db.js";
import { TenantService, normalizeConfig, type Tenant } from "./tenants.js";

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
}

const globalRunningTasks = new Set<string>();

export class BudgetService {
  static recordGlobalRunning(taskId: string): void {
    globalRunningTasks.add(taskId);
  }

  static removeGlobalRunning(taskId: string): void {
    globalRunningTasks.delete(taskId);
  }

  static async getGlobalConcurrentRunning(): Promise<number> {
    const supabase = getSupabase();
    if (supabase) {
      const { count, error } = await supabase
        .from("tasks")
        .select("*", { count: "exact", head: true })
        .eq("status", "running");
      if (error) {
        console.error("[budgets] getGlobalConcurrentRunning error:", error.message);
      } else if (typeof count === "number") {
        return count;
      }
    }
    return globalRunningTasks.size;
  }

  static async getTenantDailySpend(tenantId: string, sinceMs = 24 * 60 * 60 * 1000): Promise<number> {
    const supabase = getSupabase();
    if (supabase) {
      const since = new Date(Date.now() - sinceMs).toISOString();
      const { data, error } = await supabase
        .from("tasks")
        .select("cost_usd")
        .eq("tenant_id", tenantId)
        .gte("created_at", since)
        .not("cost_usd", "is", null);
      if (error) {
        console.error("[budgets] getTenantDailySpend error:", error.message);
      } else if (data) {
        return (data as { cost_usd: number }[]).reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
      }
    }

    return TenantService.getTenantDailySpend(tenantId);
  }

  static async isWithinBudget(tenant: Tenant | undefined, estimatedCost?: number): Promise<BudgetCheck> {
    const config = loadConfig();
    const globalRunning = await this.getGlobalConcurrentRunning();
    if (globalRunning >= config.globalMaxConcurrentSandboxes) {
      return { ok: false, reason: "global_max_concurrent_sandboxes" };
    }

    if (tenant) {
      const tenantConfig = normalizeConfig(tenant.config);
      const dailySpend = await this.getTenantDailySpend(tenant.id);
      const projected = (estimatedCost ?? 0) + dailySpend;
      if (tenantConfig.dailyCostUsd !== undefined && projected > tenantConfig.dailyCostUsd) {
        return { ok: false, reason: "tenant_daily_cost_budget" };
      }
    }

    return { ok: true };
  }
}
