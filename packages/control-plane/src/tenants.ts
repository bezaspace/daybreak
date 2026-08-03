import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { loadConfig } from "@daybreak/shared";
import { getSupabase } from "./db.js";
import { TaskRejectedError } from "./errors.js";

export interface TenantConfig {
  tasksPerHour?: number;
  dailyCostUsd?: number;
  maxConcurrent?: number;
}

export interface Tenant {
  id: string;
  type: "pat" | "github_installation" | string;
  value: string;
  config: TenantConfig;
  createdAt?: number;
  updatedAt?: number;
  dailySpend?: number;
  dailySpendDate?: string;
}

export interface TenantMembership {
  id: string;
  tenantId: string;
  userId: string;
  role: "admin" | "operator" | "viewer";
  createdAt?: number;
}

interface TaskRecord {
  taskId: string;
  createdAt: number;
  status: string;
  costUsd?: number;
}

const memoryTenants = new Map<string, Tenant>();
const tenantByTypeValue = new Map<string, string>(); // "type:value" -> id
const memoryMemberships = new Map<string, TenantMembership[]>();
const tenantTaskRecords = new Map<string, TaskRecord[]>();
const tenantRunningTasks = new Map<string, Set<string>>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function getConfigDefaults(): TenantConfig {
  const config = loadConfig();
  return {
    tasksPerHour: config.defaultTenantTasksPerHour,
    dailyCostUsd: config.defaultTenantDailyCostUsd,
    maxConcurrent: config.defaultTenantMaxConcurrent,
  };
}

export function normalizeConfig(config?: TenantConfig | null): TenantConfig {
  const defaults = getConfigDefaults();
  const c = config ?? {};
  return {
    tasksPerHour: c.tasksPerHour ?? defaults.tasksPerHour,
    dailyCostUsd: c.dailyCostUsd ?? defaults.dailyCostUsd,
    maxConcurrent: c.maxConcurrent ?? defaults.maxConcurrent,
  };
}

function tenantKey(type: string, value: string): string {
  return `${type}:${value}`;
}

export class TenantService {
  static async getTenantById(id: string): Promise<Tenant | undefined> {
    const supabase = getSupabase();
    if (supabase) {
      const { data, error } = await supabase.from("tenants").select("*").eq("id", id).maybeSingle<{
        id: string;
        type: string;
        value: string;
        config: unknown;
        created_at?: string;
        updated_at?: string;
      }>();
      if (error) {
        console.error("[tenants] getTenantById error:", error.message);
      }
      if (data) {
        return {
          id: data.id,
          type: data.type,
          value: data.value,
          config: normalizeConfig(data.config as TenantConfig),
          createdAt: data.created_at ? new Date(data.created_at).getTime() : undefined,
          updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : undefined,
        };
      }
    }
    return memoryTenants.get(id);
  }

  static async getOrCreateTenant(type: string, value: string, config?: TenantConfig): Promise<Tenant> {
    const key = tenantKey(type, value);
    const existingId = tenantByTypeValue.get(key);
    if (existingId) {
      const existing = await this.getTenantById(existingId);
      if (existing) return existing;
    }

    const supabase = getSupabase();
    if (supabase) {
      const { data, error } = await supabase
        .from("tenants")
        .upsert({ type, value, config: config ?? {} }, { onConflict: "type,value" })
        .select()
        .single<{ id: string; type: string; value: string; config: unknown; created_at?: string; updated_at?: string }>();
      if (error) {
        console.error("[tenants] getOrCreateTenant upsert error:", error.message);
      } else if (data) {
        const tenant: Tenant = {
          id: data.id,
          type: data.type,
          value: data.value,
          config: normalizeConfig(data.config as TenantConfig),
          createdAt: data.created_at ? new Date(data.created_at).getTime() : undefined,
          updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : undefined,
        };
        memoryTenants.set(tenant.id, tenant);
        tenantByTypeValue.set(key, tenant.id);
        return tenant;
      }
    }

    const tenant: Tenant = {
      id: `tenant-${type}-${value}`,
      type,
      value,
      config: normalizeConfig(config),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    memoryTenants.set(tenant.id, tenant);
    tenantByTypeValue.set(key, tenant.id);
    return tenant;
  }

  static async getOrCreateTenantForRequest(c: Context, fallback?: { owner?: string; installationId?: string; repo?: string }): Promise<Tenant> {
    const headerTenantId = c.req.header("x-daybreak-tenant-id");
    if (headerTenantId) {
      const existing = await this.getTenantById(headerTenantId);
      if (existing) return existing;
      return this.getOrCreateTenant("pat", headerTenantId);
    }

    if (fallback?.installationId) {
      return this.getOrCreateTenant("github_installation", fallback.installationId);
    }

    if (fallback?.owner) {
      return this.getOrCreateTenant("pat", fallback.owner);
    }

    if (fallback?.repo) {
      const owner = this.parseRepoOwner(fallback.repo);
      if (owner) return this.getOrCreateTenant("pat", owner);
    }

    return this.getOrCreateTenant("pat", "default");
  }

  static parseRepoOwner(repoUrl: string): string | undefined {
    try {
      const url = new URL(repoUrl);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return parts[0];
    } catch {
      // fall through
    }
    return undefined;
  }

  static async assertCanCreateTask(
    tenant: Tenant,
    userId?: string,
    role?: string,
    costEstimate?: number,
  ): Promise<void> {
    if (role === "viewer") {
      throw new TaskRejectedError("viewer role cannot create tasks", 403);
    }

    const config = normalizeConfig(tenant.config);

    // Tasks per hour
    const records = tenantTaskRecords.get(tenant.id) ?? [];
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentCount = records.filter((r) => r.createdAt > oneHourAgo).length;
    if (recentCount >= (config.tasksPerHour ?? 10)) {
      throw new TaskRejectedError("rate_limited: tenant task rate exceeded", 429);
    }

    // Daily cost budget
    const spend = this.getTenantDailySpend(tenant.id);
    const estimated = (costEstimate ?? 0) + spend;
    if (config.dailyCostUsd !== undefined && estimated > config.dailyCostUsd) {
      throw new TaskRejectedError("budget_exceeded: tenant daily cost budget exceeded", 429);
    }

    // Max concurrent
    const running = tenantRunningTasks.get(tenant.id)?.size ?? 0;
    if (config.maxConcurrent !== undefined && running >= config.maxConcurrent) {
      throw new TaskRejectedError("rate_limited: tenant max concurrency exceeded", 429);
    }
  }

  static recordTaskCreation(tenantId: string | undefined, taskId: string): void {
    if (!tenantId) return;
    const records = tenantTaskRecords.get(tenantId) ?? [];
    records.push({ taskId, createdAt: Date.now(), status: "pending" });
    tenantTaskRecords.set(tenantId, records);
    this.ensureRunningSet(tenantId);
  }

  static recordTaskStatus(tenantId: string | undefined, taskId: string, status: string): void {
    if (!tenantId) return;
    const records = tenantTaskRecords.get(tenantId) ?? [];
    const record = records.find((r) => r.taskId === taskId);
    if (record) record.status = status;

    const running = this.ensureRunningSet(tenantId);
    if (status === "running") {
      running.add(taskId);
    } else {
      running.delete(taskId);
    }
  }

  static recordTaskCost(tenantId: string | undefined, costUsd: number | undefined): void {
    if (!tenantId || costUsd === undefined || Number.isNaN(costUsd)) return;
    const tenant = memoryTenants.get(tenantId);
    if (tenant) {
      const date = today();
      if (tenant.dailySpendDate !== date) {
        tenant.dailySpend = 0;
        tenant.dailySpendDate = date;
      }
      tenant.dailySpend = (tenant.dailySpend ?? 0) + costUsd;
    }

    const records = tenantTaskRecords.get(tenantId) ?? [];
    const record = records.find((r) => r.taskId);
    if (record) record.costUsd = (record.costUsd ?? 0) + costUsd;
  }

  static getTenantDailySpend(tenantId: string): number {
    const tenant = memoryTenants.get(tenantId);
    if (tenant && tenant.dailySpendDate === today()) {
      return tenant.dailySpend ?? 0;
    }

    // Fallback: compute from in-memory records for the last 24h.
    const records = tenantTaskRecords.get(tenantId) ?? [];
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return records.filter((r) => r.createdAt > oneDayAgo).reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  }

  static getTenantRunningCount(tenantId: string): number {
    return tenantRunningTasks.get(tenantId)?.size ?? 0;
  }

  static async setMembership(tenantId: string, userId: string, role: TenantMembership["role"]): Promise<void> {
    const supabase = getSupabase();
    if (supabase) {
      const { error } = await supabase
        .from("tenant_memberships")
        .upsert({ tenant_id: tenantId, user_id: userId, role }, { onConflict: "tenant_id,user_id" });
      if (error) console.error("[tenants] setMembership error:", error.message);
    }

    const list = memoryMemberships.get(tenantId) ?? [];
    const existing = list.find((m) => m.userId === userId);
    if (existing) {
      existing.role = role;
    } else {
      list.push({ id: randomUUID(), tenantId, userId, role, createdAt: Date.now() });
    }
    memoryMemberships.set(tenantId, list);
  }

  static async getMembership(tenantId: string, userId: string): Promise<TenantMembership | undefined> {
    const supabase = getSupabase();
    if (supabase) {
      const { data, error } = await supabase
        .from("tenant_memberships")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle<{ id: string; tenant_id: string; user_id: string; role: string; created_at?: string }>();
      if (error) {
        console.error("[tenants] getMembership error:", error.message);
      } else if (data) {
        return {
          id: data.id,
          tenantId: data.tenant_id,
          userId: data.user_id,
          role: data.role as TenantMembership["role"],
          createdAt: data.created_at ? new Date(data.created_at).getTime() : undefined,
        };
      }
    }

    const list = memoryMemberships.get(tenantId) ?? [];
    return list.find((m) => m.userId === userId);
  }

  static async resolveUserRole(c: Context, tenantId: string): Promise<string | undefined> {
    const headerRole = c.req.header("x-daybreak-role");
    if (headerRole) return headerRole;

    const userId = c.req.header("x-daybreak-user-id") ?? "anonymous";
    const membership = await this.getMembership(tenantId, userId);
    return membership?.role ?? "operator";
  }

  private static ensureRunningSet(tenantId: string): Set<string> {
    let set = tenantRunningTasks.get(tenantId);
    if (!set) {
      set = new Set();
      tenantRunningTasks.set(tenantId, set);
    }
    return set;
  }
}
