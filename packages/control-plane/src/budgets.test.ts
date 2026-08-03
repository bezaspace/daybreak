import { describe, it, expect, beforeAll } from "vitest";

let BudgetService: typeof import("./budgets.js").BudgetService;
let TenantService: typeof import("./tenants.js").TenantService;

beforeAll(async () => {
  process.env.SUPABASE_URL = "";
  process.env.SUPABASE_SERVICE_KEY = "";
  process.env.UPSTASH_REDIS_REST_URL = "";
  process.env.UPSTASH_REDIS_REST_TOKEN = "";
  ({ BudgetService } = await import("./budgets.js"));
  ({ TenantService } = await import("./tenants.js"));
});

describe("BudgetService", () => {
  it("allows a task when no budgets are exceeded", async () => {
    const tenant = await TenantService.getOrCreateTenant("pat", "budget-allow");
    const check = await BudgetService.isWithinBudget(tenant, 0.1);
    expect(check.ok).toBe(true);
  });

  it("rejects when global concurrency is at the limit", async () => {
    const t1 = await TenantService.getOrCreateTenant("pat", "global-limit-1");
    const t2 = await TenantService.getOrCreateTenant("pat", "global-limit-2");
    const t3 = await TenantService.getOrCreateTenant("pat", "global-limit-3");
    const t4 = await TenantService.getOrCreateTenant("pat", "global-limit-4");
    const t5 = await TenantService.getOrCreateTenant("pat", "global-limit-5");
    BudgetService.recordGlobalRunning("r1");
    BudgetService.recordGlobalRunning("r2");
    BudgetService.recordGlobalRunning("r3");
    BudgetService.recordGlobalRunning("r4");
    BudgetService.recordGlobalRunning("r5");
    const check = await BudgetService.isWithinBudget(t1, 0.1);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("global_max_concurrent_sandboxes");
    BudgetService.removeGlobalRunning("r1");
    BudgetService.removeGlobalRunning("r2");
    BudgetService.removeGlobalRunning("r3");
    BudgetService.removeGlobalRunning("r4");
    BudgetService.removeGlobalRunning("r5");
  });

  it("rejects when tenant daily cost budget is exceeded", async () => {
    const tenant = await TenantService.getOrCreateTenant("pat", "tenant-budget", { dailyCostUsd: 0.05 });
    const check = await BudgetService.isWithinBudget(tenant, 0.1);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("tenant_daily_cost_budget");
  });

  it("rejects when tenant daily cost budget is exceeded with an estimated cost", async () => {
    const tenant = await TenantService.getOrCreateTenant("pat", "tenant-budget-est", { dailyCostUsd: 0.05 });
    const check = await BudgetService.isWithinBudget(tenant, 0.06);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("tenant_daily_cost_budget");
  });
});
