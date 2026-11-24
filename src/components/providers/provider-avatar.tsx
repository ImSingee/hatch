import { ThemeIcon } from '@mantine/core';
import {
  Cerebras,
  Claude,
  DeepSeek,
  Groq,
  Kimi,
  Minimax,
  Mistral,
  Moonshot,
  Nvidia,
  OpenAI,
  OpenRouter,
  Qwen,
  SiliconCloud,
  Stepfun,
  Vercel,
  Volcengine,
  XAI,
  XiaomiMiMo,
  ZAI,
  Zhipu,
} from '@lobehub/icons';
import { IconRobot } from '@tabler/icons-react';
import type { ComponentType } from 'react';

type AvatarComponent = ComponentType<{ size: number }>;

/**
 * Brand avatars for the built-in catalog providers. Icons are imported one by
 * one so the bundle carries only these, not the whole icon set.
 */
const CATALOG_AVATARS: Record<string, AvatarComponent> = {
  anthropic: Claude.Avatar,
  openai: OpenAI.Avatar,
  deepseek: DeepSeek.Avatar,
  openrouter: OpenRouter.Avatar,
  moonshotai: Moonshot.Avatar,
  'moonshotai-cn': Moonshot.Avatar,
  'kimi-coding': Kimi.Avatar,
  zai: ZAI.Avatar,
  'zai-coding-plan': ZAI.Avatar,
  zhipuai: Zhipu.Avatar,
  'zhipuai-coding-plan': Zhipu.Avatar,
  xai: XAI.Avatar,
  'vercel-ai-gateway': Vercel.Avatar,
  mistral: Mistral.Avatar,
  alibaba: Qwen.Avatar,
  volcengine: Volcengine.Avatar,
  'minimax-cn': Minimax.Avatar,
  siliconflow: SiliconCloud.Avatar,
  groq: Groq.Avatar,
  cerebras: Cerebras.Avatar,
  nvidia: Nvidia.Avatar,
  xiaomi: XiaomiMiMo.Avatar,
  stepfun: Stepfun.Avatar,
};

/**
 * A provider's avatar: its catalog brand when linked, else a brand guessed
 * from the API type, else a neutral robot.
 */
export function ProviderAvatar({
  catalogProviderId,
  apiType,
  size = 40,
}: {
  catalogProviderId?: string | null;
  apiType?: string;
  size?: number;
}) {
  const Avatar =
    (catalogProviderId && CATALOG_AVATARS[catalogProviderId]) ||
    (apiType === 'anthropic-messages'
      ? Claude.Avatar
      : apiType === 'openai-responses'
        ? OpenAI.Avatar
        : null);
  if (Avatar) return <Avatar size={size} />;
  return (
    <ThemeIcon size={size} radius="xl" variant="light" color="primary">
      <IconRobot size={Math.round(size * 0.55)} stroke={1.5} />
    </ThemeIcon>
  );
}
