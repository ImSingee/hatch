/**
 * Hatch's editorial layer over aidy-models: which providers the catalog
 * offers, their connection defaults where the upstream data disagrees with
 * what pi's SDKs expect, and the models enabled when a provider is added.
 * aidy-models has no notion of a recommended model, so that lives here.
 */
import type { CatalogProvider } from './types';

export type CuratedProvider = {
  id: string;
  /** Overrides the upstream base URL (pi SDK path conventions). */
  baseUrl?: string;
  apiType?: CatalogProvider['apiType'];
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
    featured: true,
    recommended: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  },
  {
    id: 'openai',
    featured: true,
    recommended: ['gpt-6.2-sol', 'gpt-6.2-astra'],
    images: true,
  },
  {
    id: 'deepseek',
    featured: true,
    recommended: ['deepseek-v4-pro', 'deepseek-flash'],
  },
  {
    id: 'openrouter',
    featured: true,
    recommended: ['anthropic/claude-opus-5.5', 'openai/gpt-6.2-sol'],
  },
  { id: 'moonshotai', featured: true, recommended: ['kimi-k3.1-pro'] },
  { id: 'zai', featured: true, recommended: ['glm-5.3'] },
  { id: 'xai', featured: true, recommended: ['grok-4.7'] },
  {
    id: 'vercel-ai-gateway',
    recommended: ['anthropic/claude-opus-5.5', 'openai/gpt-6.2-sol'],
  },
  { id: 'mistral', recommended: ['mistral-large-4'] },
  { id: 'alibaba', recommended: ['qwen3.8-max'] },
  { id: 'volcengine', recommended: ['doubao-seed-2-1-pro-260628'] },
  { id: 'zhipuai', recommended: ['glm-5.3'] },
  { id: 'moonshotai-cn', recommended: ['kimi-k3.1-pro'] },
  { id: 'zai-coding-plan', recommended: ['glm-5.4'] },
  { id: 'zhipuai-coding-plan', recommended: ['glm-5.4'] },
  {
    id: 'minimax-cn',
    // pi's Anthropic SDK appends /v1/messages itself.
    baseUrl: 'https://api.minimaxi.com/anthropic',
    recommended: ['MiniMax-M3.1-Flash'],
  },
  { id: 'kimi-coding', recommended: ['kimi-k2-thinking'] },
  { id: 'siliconflow', recommended: ['zai-org/GLM-5.3'] },
  { id: 'groq', recommended: ['openai/gpt-oss-120b'] },
  { id: 'cerebras', recommended: ['gpt-oss-120b'] },
  { id: 'nvidia', recommended: ['deepseek-ai/deepseek-v4.1-flash'] },
  { id: 'xiaomi', recommended: ['mimo-v2.6-pro'] },
  { id: 'stepfun', recommended: ['step-5-preview'] },
];
