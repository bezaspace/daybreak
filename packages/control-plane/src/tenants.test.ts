import { describe, it, expect, beforeAll } from "vitest";

let TenantService: typeof import("./tenants.js").TenantService;
let TaskRejectedError: typeof import("./errors.js").TaskRejectedError;

beforeAll(async () => {
  process.env.SUPABASE_URL = "";
  process.env.SUPABASE_SERVICE_KEY = "";
  process.env.UPSTASH_REDIS_REST_URL = "";
  process.env.UPSTASH_REDIS_REST_TOKEN = "";
  ({ TenantService } = await import("./tenants.js"));
  ({ TaskRejectedError } = await import("./errors.js"));
});

describe("TenantService", () => {
  it("getOrCreateTenant returns the same tenant for the same type/value", async () => {
    const a = await TenantService.getOrCreateTenant("pat", "owner-a");
    const b = await TenantService.getOrCreateTenant("pat", "owner-a");
    expect(a.id).toBe(b.id);
  });

  it("allows task creation by default", async () => {
    const tenant = await TenantService.getOrCreateTenant("pat", "allow-test");
    await expect(TenantService.assertCanCreateTask(tenant, "u1", "operator", 0.1)).resolves.toBeUndefined();
  });

  it("rejects viewers", async () => {
    const tenant = await TenantService.getOrCreateTenant("pat", "viewer-test");
    await expect(TenantService.assertCanCreateTask(tenant, "u1", "viewer", 0.1)).rejects.toThrow(TaskRejectedError);
  });

  it("enforces tasks per hour", async () => {
    const tenant = await TenantService.getOrCreateTenant("pat", "rate-test", { tasksPerHour: 2 });
    TenantService.recordTaskCreation(tenant.id, "t1");
    TenantService.recordTaskCreation(tenant.id, "t2");
    await expect(TenantService.assertCanCreateTask(tenant, "u1", "operator", 0.1)).rejects.toThrow(TaskRejectedError);
  });

  it("enforces daily cost budget", async () => {
    const tenant = await TenantService.getOrCreateTenant("pat", "budget-test", { dailyCostUsd: 0.05 });
    await expect(TenantService.assertCanCreateTask(tenant, "u1", "operator", 0.1)).rejects.toThrow(TaskRejectedError);
  });

  it("enforces max concurrent", async () => {
    const tenant = await TenantService.getOrCreateTenant("pat", "concurrent-test", { maxConcurrent: 1 });
    TenantService.recordTaskCreation(tenant.id, "t1");
    TenantService.recordTaskStatus(tenant.id, "t1", "running");
    await expect(TenantService.assertCanCreateTask(tenant, "u1", "operator", 0.1)).rejects.toThrow(TaskRejectedError);
  });
});
