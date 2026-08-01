import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "@daybreak/shared";

export const PRIMARY_PROVIDER_ID = "daybreak-primary";
export const FALLBACK_PROVIDER_ID = "daybreak-fallback";

function buildModel(config: AgentConfig, providerId: string): Model<"openai-completions"> {
  if (!config.modelId) {
    throw new Error("LLM modelId is required");
  }

  return {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: providerId,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function buildProvider(config: AgentConfig, providerId: string, envVarName: string) {
  const model = buildModel(config, providerId);

  return createProvider({
    id: providerId,
    name: `${providerId} (Daybreak)`,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(envVarName, [envVarName]) },
    models: [model],
    api: openAICompletionsApi(),
  });
}

export async function createModelRuntime(primary: AgentConfig, fallback?: AgentConfig) {
  const modelRuntime = await ModelRuntime.create({});

  const primaryProvider = buildProvider(primary, PRIMARY_PROVIDER_ID, "LLM_API_KEY");
  modelRuntime.registerNativeProvider(primaryProvider);

  if (fallback) {
    const fallbackProvider = buildProvider(fallback, FALLBACK_PROVIDER_ID, "LLM_FALLBACK_API_KEY");
    modelRuntime.registerNativeProvider(fallbackProvider);
  }

  const model = modelRuntime.getModel(PRIMARY_PROVIDER_ID, primary.modelId);
  if (!model) {
    throw new Error(`Model ${primary.modelId} not found in provider ${PRIMARY_PROVIDER_ID}`);
  }

  return { modelRuntime, model };
}

export function getFallbackModel(
  modelRuntime: ModelRuntime,
  fallback: AgentConfig,
) {
  const model = modelRuntime.getModel(FALLBACK_PROVIDER_ID, fallback.modelId);
  if (!model) {
    throw new Error(`Fallback model ${fallback.modelId} not found in provider ${FALLBACK_PROVIDER_ID}`);
  }
  return model;
}
