/**
 * AI provider abstraction for ChromeUse MCP.
 *
 * Supports OpenRouter (including Jev Router) and any OpenAI-compatible API.
 * Configured via environment variables:
 *
 *   CHROMEUSE_AI_API_KEY     - API key (required for AI features)
 *   CHROMEUSE_AI_BASE_URL    - API base URL (default: https://openrouter.ai/api/v1)
 *   CHROMEUSE_AI_MODEL       - Model ID (default: typesafe/jev-router)
 *   CHROMEUSE_AI_MAX_TOKENS  - Max response tokens (default: 500)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string | AiContentPart[];
}

export interface AiContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface AiCompletionOptions {
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Request JSON output format */
  jsonMode?: boolean;
}

export interface AiCompletionResult {
  text: string | null;
  model: string;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number };
  finishReason?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AiProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  defaultMaxTokens: number;
}

export function loadAiConfig(): AiProviderConfig | null {
  const apiKey = process.env.CHROMEUSE_AI_API_KEY;
  if (!apiKey) return null;

  return {
    apiKey,
    baseUrl:
      process.env.CHROMEUSE_AI_BASE_URL ?? "https://openrouter.ai/api/v1",
    model: process.env.CHROMEUSE_AI_MODEL ?? "typesafe/jev-router",
    defaultMaxTokens: parseInt(
      process.env.CHROMEUSE_AI_MAX_TOKENS ?? "500",
      10
    ),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AiProvider {
  readonly config: AiProviderConfig;

  constructor(config: AiProviderConfig) {
    this.config = config;
  }

  /** Whether AI features are available. */
  get available(): boolean {
    return Boolean(this.config.apiKey);
  }

  /**
   * Send a chat completion request.
   * Returns structured result with routing info (model actually used).
   */
  async complete(opts: AiCompletionOptions): Promise<AiCompletionResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? this.config.defaultMaxTokens,
    };

    if (opts.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    // Some providers support response_format for JSON
    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const start = performance.now();

    const res = await fetch(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI API ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      model?: string;
      choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };

    const choice = data.choices?.[0];

    return {
      text: choice?.message?.content ?? null,
      model: data.model ?? this.config.model,
      latencyMs,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
      finishReason: choice?.finish_reason,
    };
  }
}

/** Singleton — returns null when not configured. */
let _instance: AiProvider | null | undefined;

export function getAiProvider(): AiProvider | null {
  if (_instance !== undefined) return _instance;
  const config = loadAiConfig();
  _instance = config ? new AiProvider(config) : null;
  return _instance;
}
