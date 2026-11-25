/**
 * Hatch's editorial layer over aidy-models: which providers the catalog
 * offers, their connection defaults where the upstream data disagrees with
 * what pi's SDKs expect, and the models enabled when a provider is added.
 * aidy-models has no notion of a recommended model, so that lives here.
 */
import type { CatalogProvider } from './types';

export type CuratedProvider = {
  id: string;
  /**
   * The vendor's endpoint, pinned here rather than taken from the feed: a
   * compromised feed or mirror must never choose where a preset sends the
   * user's key. Paths follow pi's SDK conventions. A custom provider can
   * still point anywhere.
   */
  baseUrl: string;
  apiType: CatalogProvider['apiType'];
  featured?: boolean;
  /** Model ids enabled by default, best first. Must exist in the catalog. */
  recommended: string[];
  /** Image models are offered only where an image driver is verified. */
  images?: boolean;
};

/** Gallery order: featured vendors first, then gateways and others. */
export const CURATED_PROVIDERS: readonly CuratedProvider[] = [
  {
    id: 'anthropic',
    apiType: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    featured: true,
    recommended: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  },
  {
    id: 'openai',
    apiType: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    featured: true,
    recommended: ['gpt-6.2-sol', 'gpt-6.2-astra'],
    images: true,
  },
  {
    id: 'deepseek',
    apiType: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    featured: true,
    recommended: ['deepseek-v4-pro', 'deepseek-flash'],
  },
  {
    id: 'openrouter',
    apiType: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    featured: true,
    recommended: ['anthropic/claude-opus-5.5', 'openai/gpt-6.2-sol'],
  },
  {
    id: 'moonshotai',
    apiType: 'openai-completions',
    baseUrl: 'https://api.moonshot.ai/v1',
    featured: true,
    recommended: ['kimi-k3.1-pro'],
  },
  {
    id: 'zai',
    apiType: 'openai-completions',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    featured: true,
    recommended: ['glm-5.3'],
  },
  {
    id: 'xai',
    apiType: 'openai-completions',
    baseUrl: 'https://api.x.ai/v1',
    featured: true,
    recommended: ['grok-4.7'],
  },
  {
    id: 'vercel-ai-gateway',
    apiType: 'openai-completions',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    recommended: ['anthropic/claude-opus-5.5', 'openai/gpt-6.2-sol'],
  },
  {
    id: 'mistral',
    apiType: 'openai-completions',
    baseUrl: 'https://api.mistral.ai/v1',
    recommended: ['mistral-large-4'],
  },
  {
    id: 'alibaba',
    apiType: 'openai-completions',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    recommended: ['qwen3.8-max'],
  },
  {
    id: 'volcengine',
    apiType: 'openai-completions',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    recommended: ['doubao-seed-2-1-pro-260628'],
  },
  {
    id: 'zhipuai',
    apiType: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    recommended: ['glm-5.3'],
  },
  {
    id: 'moonshotai-cn',
    apiType: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    recommended: ['kimi-k3.1-pro'],
  },
  {
    id: 'zai-coding-plan',
    apiType: 'openai-completions',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    recommended: ['glm-5.4'],
  },
  {
    id: 'zhipuai-coding-plan',
    apiType: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    recommended: ['glm-5.4'],
  },
  {
    id: 'minimax-cn',
    apiType: 'anthropic-messages',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    recommended: ['MiniMax-M3.1-Flash'],
  },
  {
    id: 'kimi-coding',
    apiType: 'anthropic-messages',
    baseUrl: 'https://api.kimi.com/coding',
    recommended: ['kimi-k2-thinking'],
  },
  {
    id: 'siliconflow',
    apiType: 'openai-completions',
    baseUrl: 'https://api.siliconflow.com/v1',
    recommended: ['zai-org/GLM-5.3'],
  },
  {
    id: 'groq',
    apiType: 'openai-completions',
    baseUrl: 'https://api.groq.com/openai/v1',
    recommended: ['openai/gpt-oss-120b'],
  },
  {
    id: 'cerebras',
    apiType: 'openai-completions',
    baseUrl: 'https://api.cerebras.ai/v1',
    recommended: ['gpt-oss-120b'],
  },
  {
    id: 'nvidia',
    apiType: 'openai-completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    recommended: ['deepseek-ai/deepseek-v4.1-flash'],
  },
  {
    id: 'xiaomi',
    apiType: 'openai-completions',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    recommended: ['mimo-v2.6-pro'],
  },
  {
    id: 'stepfun',
    apiType: 'openai-completions',
    baseUrl: 'https://api.stepfun.com/v1',
    recommended: ['step-5-preview'],
  },
];
