import { Redis } from "@upstash/redis";

export interface StreamEvent {
  id: string;
  taskId: string;
  type: string;
  timestamp: number;
  data: unknown;
}

export interface StreamPublisherConfig {
  upstashRedisRestUrl?: string;
  upstashRedisToken?: string;
  taskId?: string;
}

export function createStreamPublisher(config: StreamPublisherConfig) {
  const url = config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL;
  const token = config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN;
  const taskId = config.taskId || process.env.TASK_ID || `task-${Date.now()}`;

  if (!url || !token) {
    return {
      publish: () => {},
      flush: async () => {},
      close: async () => {},
    };
  }

  const redis = new Redis({ url, token });
  const buffer: StreamEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let seq = 0;
  const key = `daybreak:stream:${taskId}`;

  async function flush() {
    if (buffer.length === 0) return;
    const events = buffer.splice(0, buffer.length);
    const pipe = redis.pipeline();
    for (const ev of events) {
      pipe.rpush(key, JSON.stringify(ev));
    }
    pipe.ltrim(key, -1000, -1);
    try {
      await pipe.exec();
    } catch (error) {
      console.error("[stream] flush error:", error);
    }
  }

  function schedule() {
    if (timer || closed) return;
    timer = setInterval(() => {
      flush().catch(() => {});
    }, 100);
  }

  process.once("beforeExit", () => {
    flush().catch(() => {});
  });

  return {
    publish: (type: string, data: unknown) => {
      if (closed) return;
      buffer.push({
        id: `${taskId}-${++seq}`,
        taskId,
        type,
        timestamp: Date.now(),
        data,
      });
      schedule();
    },
    flush,
    close: async () => {
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await flush();
    },
  };
}
