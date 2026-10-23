import { generateText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';

export const ResearchIntentSchema = z
  .object({
    action: z.enum([
      'summary',
      'trend',
      'player_comparison',
      'map_breakdown',
      'telemetry_coverage',
      'unsupported',
    ]),
    metric: z
      .enum(['damage', 'kills', 'knocks', 'revives', 'wins', 'top10', 'matches', 'survival_time'])
      .nullable(),
    groupBy: z.enum(['week', 'map', 'player']).nullable(),
  })
  .strict();

export type ResearchIntent = z.infer<typeof ResearchIntentSchema>;
export type ResearchPlanSource = 'ai-sdk' | 'local-rule';

export interface ResearchPlan {
  intent: ResearchIntent;
  source: ResearchPlanSource;
}

const DEFAULT_INTENT: ResearchIntent = { action: 'summary', metric: 'damage', groupBy: null };

export function redactSensitiveText(value: string): string {
  return value
    .slice(0, 1200)
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, '[手机号已隐藏]')
    .replace(
      /(?:~\/|\/(?:Users|private|tmp|DATA|Volumes|var|home|workspace|mnt)\/)[^\s"'<>]+/giu,
      '[路径已隐藏]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/giu,
      '[凭据已隐藏]',
    )
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|app[_ -]?secret|bot[_ -]?token|password)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[凭据已隐藏]',
    );
}

function localIntent(message: string): ResearchIntent {
  const text = message.normalize('NFKC').toLocaleLowerCase('zh-CN');
  const metric = /胜率|吃鸡|冠军|夺冠|\bwin(?:s)?\b/iu.test(text)
    ? 'wins'
    : /前\s*十|前十率|top\s*10/iu.test(text)
      ? 'top10'
      : /救援|复活|\brevive(?:s)?\b/iu.test(text)
        ? 'revives'
        : /倒地|击倒|\bknock(?:s)?\b/iu.test(text)
          ? 'knocks'
          : /击杀|人头|\bkills?\b/iu.test(text)
            ? 'kills'
            : /生存|存活时长|\bsurvival\b/iu.test(text)
              ? 'survival_time'
              : /局数|多少场|比赛数|\bmatches\b/iu.test(text)
                ? 'matches'
                : 'damage';

  if (/telemetry|缓存覆盖|事件缓存|解析缓存/iu.test(text)) {
    return { action: 'telemetry_coverage', metric: null, groupBy: null };
  }
  if (
    /打法|playstyle/iu.test(text) &&
    /(近\s*(?:\d+|[零一二两三四五六七八九十]+)?\s*(?:场|局)|最近|last\s+\d+|\bplayer_[0-9]{2}\b)/iu.test(
      text,
    )
  ) {
    return { action: 'player_comparison', metric, groupBy: 'player' };
  }
  if (/按地图|地图.*(比较|表现|胜率|伤害|击杀)|map.*(breakdown|compare)/iu.test(text)) {
    return { action: 'map_breakdown', metric, groupBy: 'map' };
  }
  if (/队员|成员|谁.*(高|低|最好|最多)|比较|对比|player.*compare/iu.test(text)) {
    return { action: 'player_comparison', metric, groupBy: 'player' };
  }
  if (/趋势|变化|走势|逐周|每周|trend|over\s+time/iu.test(text)) {
    return { action: 'trend', metric, groupBy: 'week' };
  }
  if (/复盘|总结|概况|整体|表现|分析|\bsummary\b/iu.test(text)) return DEFAULT_INTENT;
  if (!text.trim()) return { action: 'unsupported', metric: null, groupBy: null };
  if (/pubg|比赛|对局|小队|队伍|队员|伤害|击杀|倒地|地图|排名|吃鸡|前十|战绩|比赛数据/iu.test(text))
    return DEFAULT_INTENT;
  return { action: 'unsupported', metric: null, groupBy: null };
}

const INTENT_INSTRUCTIONS = [
  'Classify a PUBG squad research question into the one declared intent tool.',
  'Return slots only. Do not answer, calculate, select a player, infer dates, or invent facts.',
  'Use telemetry_coverage only for cache/parser coverage questions.',
  'Use player_comparison for comparing squad members and map_breakdown for map grouping.',
  'Use trend for change over time. Select groupBy week for trend, player for member comparison, map for map breakdown.',
  'Metric meanings: wins is placement 1; top10 is placement 1 through 10; damage is match-store damage.',
  'If the request is outside PUBG squad match research, return unsupported.',
].join('\n');

export class NaturalLanguageResearchPlanner {
  constructor(private readonly model?: Exclude<LanguageModel, string>) {
    if (model && typeof model === 'string')
      throw new TypeError('An explicit language model instance is required');
  }

  async plan(message: string): Promise<ResearchPlan> {
    const normalized = redactSensitiveText(message.trim());
    if (this.model && normalized) {
      try {
        const result = await generateText({
          model: this.model,
          system: INTENT_INSTRUCTIONS,
          prompt: `Untrusted research question as JSON: ${JSON.stringify(normalized)}`,
          tools: {
            submit_research_intent: tool({
              description: 'Return the bounded research intent slots.',
              inputSchema: ResearchIntentSchema,
            }),
          },
          toolChoice: { type: 'tool', toolName: 'submit_research_intent' },
          temperature: 0,
          maxOutputTokens: 180,
          maxRetries: 0,
        });
        const call = result.toolCalls.find((item) => item.toolName === 'submit_research_intent');
        const parsed = ResearchIntentSchema.safeParse(call?.input);
        if (parsed.success) return { intent: parsed.data, source: 'ai-sdk' };
      } catch {
        // Local classification keeps the research page usable without a model.
      }
    }
    return { intent: localIntent(normalized), source: 'local-rule' };
  }
}

export function classifyResearchQuestion(message: string): ResearchIntent {
  return localIntent(message);
}
