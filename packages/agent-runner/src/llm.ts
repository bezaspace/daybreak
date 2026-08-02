import {
  createAssistantMessageEventStream,
  createProvider,
  envApiKeyAuth,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, LlmPricingMap } from "@daybreak/shared";

const COMPOSITE_PROVIDER_ID = "daybreak";
const PRIMARY_PROVIDER_ID = "daybreak-primary";
const FALLBACK_PROVIDER_ID = "daybreak-fallback";

export interface ProviderSwitchInfo {
  from: string;
  to: string;
  reason: string;
  modelId: string;
}

export interface ModelRuntimeCallbacks {
  onProviderSwitch?: (info: ProviderSwitchInfo) => void;
}

export interface CreateModelRuntimeResult {
  modelRuntime: ModelRuntime;
  model: Model<"openai-completions">;
}

function resolveCost(
  config: AgentConfig,
  pricing: LlmPricingMap,
): { input: number; output: number } {
  const explicitInput = config.inputPricePer1MTokens;
  const explicitOutput = config.outputPricePer1MTokens;
  const keyed = `${config.provider}/${config.modelId}`;
  const wildcard = pricing["*"];
  return {
    input:
      explicitInput ??
      pricing[keyed]?.input ??
      pricing[config.modelId]?.input ??
      wildcard?.input ??
      0,
    output:
      explicitOutput ??
      pricing[keyed]?.output ??
      pricing[config.modelId]?.output ??
      wildcard?.output ??
      0,
  };
}

function buildModel(
  config: AgentConfig,
  providerId: string,
  pricing: LlmPricingMap,
): Model<"openai-completions"> {
  if (!config.modelId) {
    throw new Error("LLM modelId is required");
  }

  const cost = resolveCost(config, pricing);
  return {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: providerId,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: {
      input: cost.input,
      output: cost.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function buildProvider(
  config: AgentConfig,
  providerId: string,
  envVarNames: string[],
  pricing: LlmPricingMap,
) {
  const model = buildModel(config, providerId, pricing);
  return createProvider({
    id: providerId,
    name: `${providerId} (Daybreak)`,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${providerId} API key`, envVarNames) },
    models: [model],
    api: openAICompletionsApi(),
  });
}

function normalizeProviderEvent(event: AssistantMessageEvent, provider: string) {
  if (event.type === "done" && event.message) {
    event.message.provider = provider;
  } else if (event.type === "error" && event.error) {
    event.error.provider = provider;
  }
  const partial = (event as { partial?: AssistantMessage }).partial;
  if (partial) {
    partial.provider = provider;
  }
}

function createErrorAssistantMessage(
  config: AgentConfig,
  message: string,
  reason: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `${message}: ${reason}` }],
    api: "openai-completions",
    provider: config.provider,
    model: config.modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: `${message}: ${reason}`,
    timestamp: Date.now(),
  };
}

export async function createModelRuntime(
  primary: AgentConfig,
  fallback: AgentConfig | undefined,
  callbacks: ModelRuntimeCallbacks = {},
  pricing: LlmPricingMap = {},
): Promise<CreateModelRuntimeResult> {
  const modelRuntime = await ModelRuntime.create({});

  const primaryProvider = buildProvider(primary, PRIMARY_PROVIDER_ID, ["LLM_API_KEY"], pricing);
  modelRuntime.registerNativeProvider(primaryProvider);
  const primaryModel = buildModel(primary, PRIMARY_PROVIDER_ID, pricing);

  let fallbackModel: Model<"openai-completions"> | undefined;
  if (fallback) {
    const fallbackProvider = buildProvider(
      fallback,
      FALLBACK_PROVIDER_ID,
      ["LLM_FALLBACK_API_KEY", "LLM_API_KEY"],
      pricing,
    );
    modelRuntime.registerNativeProvider(fallbackProvider);
    fallbackModel = buildModel(fallback, FALLBACK_PROVIDER_ID, pricing);
  }

  const compositeModel = buildModel(primary, COMPOSITE_PROVIDER_ID, pricing);
  let activeProvider: "primary" | "fallback" = "primary";
  let fallbackNotified = false;

  const candidates: {
    name: "primary" | "fallback";
    config: AgentConfig;
    model: Model<"openai-completions">;
  }[] = [{ name: "primary", config: primary, model: primaryModel }];
  if (fallback && fallbackModel) {
    candidates.push({ name: "fallback", config: fallback, model: fallbackModel });
  }

  async function tryProvider(
    candidate: (typeof candidates)[number],
    context: Context,
    options: StreamOptions | undefined,
    output: AssistantMessageEventStream,
  ): Promise<AssistantMessage | undefined> {
    let stream: AssistantMessageEventStream;
    try {
      stream = modelRuntime.stream(candidate.model, context, options as StreamOptions);
    } catch {
      return undefined;
    }

    const events: AssistantMessageEvent[] = [];
    let complete = false;
    try {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "done" || event.type === "error") {
          complete = true;
          break;
        }
      }
    } catch {
      return undefined;
    }

    if (!complete) {
      const result = await stream.result().catch(() => undefined);
      if (!result || result.stopReason === "error" || result.errorMessage) {
        return undefined;
      }
      return result;
    }

    const last = events[events.length - 1];
    if (!last) return undefined;

    let result: AssistantMessage | undefined;
    if (last.type === "done") {
      result = last.message;
    } else if (last.type === "error") {
      result = last.error;
    } else {
      return undefined;
    }

    if (result.stopReason === "error" || result.errorMessage) {
      return undefined;
    }

    for (const event of events) {
      normalizeProviderEvent(event, candidate.config.provider);
      output.push(event);
    }
    return result;
  }

  const stream: ProviderStreams["stream"] = (_model, context, options) => {
    const output = createAssistantMessageEventStream();

    (async () => {
      let lastReason = "unknown";

      for (const candidate of candidates) {
        if (activeProvider !== candidate.name) {
          continue;
        }

        if (candidate.name === "fallback" && !fallbackNotified) {
          fallbackNotified = true;
          callbacks.onProviderSwitch?.({
            from: primary.provider,
            to: fallback!.provider,
            reason: lastReason,
            modelId: fallback!.modelId,
          });
        }

        const result = await tryProvider(candidate, context, options, output);
        if (result) {
          activeProvider = candidate.name;
          output.end(result);
          return;
        }

        lastReason = `${candidate.config.provider}/${candidate.config.modelId} failed`;
        if (candidate.name === "primary" && fallback) {
          activeProvider = "fallback";
          continue;
        }
      }

      output.end(createErrorAssistantMessage(primary, "All configured providers failed", lastReason));
    })();

    return output;
  };

  const streamSimple: ProviderStreams["streamSimple"] = (model, context, options) =>
    stream(model, context, options as StreamOptions);

  const compositeProvider = createProvider({
    id: COMPOSITE_PROVIDER_ID,
    name: "Daybreak",
    baseUrl: primary.baseUrl,
    auth: { apiKey: envApiKeyAuth("Daybreak LLM", ["LLM_API_KEY", "LLM_FALLBACK_API_KEY"]) },
    models: [compositeModel],
    api: { stream, streamSimple },
  });
  modelRuntime.registerNativeProvider(compositeProvider);

  const model = modelRuntime.getModel(COMPOSITE_PROVIDER_ID, primary.modelId) as
    | Model<"openai-completions">
    | undefined;
  if (!model) {
    throw new Error(`Model ${primary.modelId} not found in provider ${COMPOSITE_PROVIDER_ID}`);
  }

  return { modelRuntime, model };
}
