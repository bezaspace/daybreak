import { context, diag, trace, type Span, type Tracer, type Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { TracerProvider, BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter, type IdGenerator } from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const LANGFUSE_OTLP_PATH = "/api/public/otel/v1/traces";
const SERVICE_NAME = "daybreak-agent";

let contextManagerInstalled = false;

function ensureContextManager(): void {
  if (contextManagerInstalled) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  contextManagerInstalled = true;
}

function deriveTraceId(taskId: string): string {
  const hex = taskId.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (/^[a-f0-9]{32}$/.test(hex)) return hex;
  return createHash("sha256").update(taskId).digest("hex").slice(0, 32);
}

class TaskIdGenerator implements IdGenerator {
  private usedTraceId = false;

  constructor(private readonly traceId: string) {}

  generateTraceId(): string {
    if (!this.usedTraceId) {
      this.usedTraceId = true;
      return this.traceId;
    }
    return randomBytes(16).toString("hex");
  }

  generateSpanId(): string {
    return randomBytes(8).toString("hex");
  }
}

export interface TelemetryInit {
  provider: TracerProvider;
  tracer: Tracer;
  taskId: string;
  traceId: string;
}

export interface TelemetryOptions {
  taskId?: string;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  serviceName?: string;
}

export function initTelemetry(options: TelemetryOptions): TelemetryInit {
  ensureContextManager();

  const taskId = options.taskId || randomUUID();
  const traceId = deriveTraceId(taskId);

  const baseUrl = (options.baseUrl || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const publicKey = options.publicKey || "";
  const secretKey = options.secretKey || "";

  let processor;
  if (publicKey && secretKey) {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const exporter = new OTLPTraceExporter({
      url: `${baseUrl}${LANGFUSE_OTLP_PATH}`,
      headers: {
        Authorization: `Basic ${auth}`,
        "x-langfuse-ingestion-version": "4",
      },
      timeoutMillis: 15000,
    });
    processor = new BatchSpanProcessor({
      exporter,
      maxQueueSize: 1000,
      maxExportBatchSize: 100,
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: 15000,
    });
  } else {
    diag.warn("[telemetry] LANGFUSE_PUBLIC_KEY/SECRET_KEY missing; emitting spans to console instead of Langfuse.");
    processor = new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() });
  }

  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName || SERVICE_NAME,
      "task.id": taskId,
    }),
    spanProcessors: [processor],
    idGenerator: new TaskIdGenerator(traceId),
  });

  const tracer = provider.getTracer("daybreak-agent");
  return { provider, tracer, taskId, traceId };
}

export async function shutdownTelemetry(provider?: TracerProvider): Promise<void> {
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch (error) {
    console.error("[telemetry] shutdown error:", error instanceof Error ? error.message : String(error));
  }
}

export type { Span, Tracer, Context };
