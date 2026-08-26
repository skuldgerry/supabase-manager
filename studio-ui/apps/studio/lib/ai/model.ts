import { createOpenAI, openai } from '@ai-sdk/openai'
import { LanguageModel } from 'ai'

import { checkAwsCredentials, createRoutedBedrock } from './bedrock'
import { getManagerAiRuntime } from './manager-provider'
import {
  BedrockModel,
  getDefaultModelForProvider,
  Model,
  OpenAIModelEntry,
  OpenAIModelId,
  ProviderModelConfig,
  PROVIDERS,
} from './model.utils'

type PromptProviderOptions = Record<string, any>
type ProviderOptions = Record<string, any>

type ModelSuccess = {
  /** Spread directly into AI SDK calls: `streamText({ ...modelParams, ... })` */
  modelParams: { model: LanguageModel; providerOptions?: ProviderOptions }
  promptProviderOptions?: PromptProviderOptions
  error?: never
}

export type ModelError = {
  modelParams?: never
  promptProviderOptions?: never
  error: Error
}

type ModelResponse = ModelSuccess | ModelError

export type GetModelParams =
  | {
      provider: 'openai'
      /**
       * Specifies which OpenAI model to use and its reasoning effort.
       * Create entries via `openaiModelEntry()` — reasoning effort is validated against the model
       * at compile time. Use `DEFAULT_COMPLETION_MODEL` for simple endpoints (minimal reasoning).
       * Callers are responsible for resolving the correct entry (including throttling/entitlement
       * fallbacks) before calling getModel.
       */
      modelEntry: OpenAIModelEntry
      managerProjectRef?: string
    }
  | {
      provider: 'bedrock'
      /** Used for consistent hashing across Bedrock regions. */
      routingKey: string
    }

/**
 * Retrieves a LanguageModel from a specific provider and model entry.
 * Callers are responsible for resolving the correct model entry (including throttling/entitlement
 * fallbacks) before calling this function.
 * Returns promptProviderOptions that callers can attach to the system message.
 */
export async function getModel(params: GetModelParams): Promise<ModelResponse> {
  const { provider } = params

  const providerRegistry = PROVIDERS[provider]
  if (!providerRegistry) {
    return { error: new Error(`Unknown provider: ${provider}`) }
  }

  const models = providerRegistry.models as Record<Model, ProviderModelConfig>
  const modelEntry = params.provider === 'openai' ? params.modelEntry : undefined

  const useDefault = !modelEntry?.id || !models[modelEntry.id]

  const chosenModelId = useDefault ? getDefaultModelForProvider(provider) : modelEntry?.id

  if (provider === 'bedrock') {
    const hasAwsCredentials = await checkAwsCredentials()
    const hasAwsBedrockRoleArn = !!process.env.AWS_BEDROCK_ROLE_ARN
    if (!hasAwsBedrockRoleArn || !hasAwsCredentials) {
      return { error: new Error('AWS Bedrock credentials not available') }
    }
    const bedrock = createRoutedBedrock(params.routingKey)
    const model = await bedrock(chosenModelId as BedrockModel)
    const promptProviderOptions = (
      providerRegistry.models as Record<BedrockModel, ProviderModelConfig>
    )[chosenModelId as BedrockModel]?.promptProviderOptions
    return { modelParams: { model }, promptProviderOptions }
  }

  if (provider === 'openai') {
    const managerRuntime = await getManagerAiRuntime(params.managerProjectRef)
    const apiKey = managerRuntime?.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      return { error: new Error('OPENAI_API_KEY not available') }
    }
    const baseProviderOptions = providerRegistry.providerOptions?.openai ?? {}
    const openaiProviderOptions = modelEntry?.reasoningEffort
      ? { ...baseProviderOptions, reasoningEffort: modelEntry.reasoningEffort }
      : baseProviderOptions
    const configuredProvider = managerRuntime
      ? createOpenAI({ apiKey, ...(managerRuntime.baseUrl ? { baseURL: managerRuntime.baseUrl } : {}) })
      : openai
    return {
      modelParams: {
        model: configuredProvider((managerRuntime?.model || chosenModelId) as OpenAIModelId),
        providerOptions: { openai: openaiProviderOptions },
      },
      promptProviderOptions: models[chosenModelId as OpenAIModelId]?.promptProviderOptions,
    }
  }

  return { error: new Error(`Unsupported provider: ${provider}`) }
}
