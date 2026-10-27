import { pubgReplyGuide, type PubgPresentation } from '@rine-kit/presentation';

/*
 * The squad chat's reply guide: the shared rules from @rine-kit/presentation plus a worked example in this squad's
 * voice (Kurisu, the group's 称呼). The example is what keeps the model on the rich 战报 shape after a session reset.
 */

const STATS_TEMPLATE = [
  '写法示例（数字仅示意，实际以 displayText 为准）：',
  '……{{b.name}}！下午还嚷嚷着让我吃子弹，晚上一查战绩，你这火力全倾泻在敌人身上了啊？！',
  '',
  '🏆 10月18日星期日 全天战报',
  '',
  '🥇 **效率杀手：{{a.name}}（{{a.account}}）**',
  '• **出战 3 局**：**5 杀**，1 助攻，1283.7 伤害，9 击倒，1 救援，2 爆头，2 次前十',
  '• 个人数据：**KD 1.67**，场均伤害 427.9，最远击杀 314.3m，3 死',
  '• AI 锐评：只玩了三把，KD 1.67 全队最高，场均 427.9 伤害，每把都在暴力抽靶，打完就跑，标准的效率派。',
  '',
  '🥈 **火力真大核·反派逆袭：{{b.name}}（{{b.account}}）**',
  '• **出战 8 局**：**10 杀**，**11 助攻（全队助攻王）**，**2743.0 伤害（全队伤害第一）**，**15 击倒（破点王）**，3 救援，3 爆头，6 次前十，**1 吃鸡**',
  '• 个人数据：**KD 1.43**，场均伤害 342.9，最远击杀 318.5m，7 死',
  '• AI 锐评：下午还在问自己是不是反派，今晚直接化身终极大 BOSS！8 局轰了 2700 多伤害外加 11 个助攻，这火力确实没得黑。',
  '',
  '（其余队员同样一人一张卡）',
  '',
  '**团队合计：29 杀，6779.9 伤害，40 击倒，18 助攻，14 救援，团队 KD 1.00，吃鸡 1**',
  '',
  '{{b.name}}单人砍了 2743 点输出，看来考完试脑神经元彻底释放了。都快半夜了，战报查爽了就赶紧关电脑睡觉去，笨蛋！',
  '',
  '🔗 （displayText 里的分享链接）',
].join('\n');

const TEAM_DAMAGE_TEMPLATE = [
  '写法示例（数字仅示意）：',
  '……刚自封完「天上天下唯我独尊」，一转头就来对账了是吧，{{b.name}}！',
  '',
  '🥊 10月18日星期日 队内误伤账本',
  '• 总误伤：**738.8 点**',
  '• 总命中：**37 次**（飞踢 33 次、重拳 2 次、小轿车撞击 2 次）',
  '',
  '───',
  '',
  '**互相伤害明细（共 4 个方向）：**',
  '1. **狂气压制：{{c.name}}（{{c.account}}） ➡️ {{b.name}}（{{b.account}}）**',
  '  • 总输出：**16 次命中，造成 334.7 伤害**（飞踢 16 次）',
  '  • 狂气所长只要近身，脚尖就焊死在你身上，单向对内输出全场最高！',
  '2. **疯狂反扑：{{b.name}}（{{b.account}}） ➡️ {{c.name}}（{{c.account}}）**',
  '  • 总输出：**16 次命中，造成 267.0 伤害**（飞踢 14 次、重拳 2 次）',
  '  • 你们俩今天整整 32 次肉搏互换，对攻 601.7 点，占全队内讧的 81%！',
  '',
  '───',
  '',
  '**名场面：**',
  '• 第 9 局（米拉玛 #12，21:01）：单局 **263.5 点（12 次命中）**：{{c.name}} ➡️ {{b.name}} 7 次 174.5 点；{{b.name}} ➡️ {{c.name}} 5 次 89.0 点。两人踢得尘土飞扬！',
  '',
  '清白名单：{{d.name}}今天继续保持清白，0 次主动队内输出。',
  '',
  '总结：对外你是 MVP，对内你挨了 334 点、还了 267 点，稳稳领跑全场内耗核心！账本焊死在这了，赶紧关机睡觉去，最强肉盾猴！',
].join('\n');

/** The squad members the worked examples talk about: three players (name and PUBG account) and one clean-record player. */
export interface ExampleSquad {
  a: { name: string; account: string };
  b: { name: string; account: string };
  c: { name: string; account: string };
  d: { name: string };
}

/** Lab's squad, as the examples have always named it: the default, so Lab's output does not change. */
export const LAB_EXAMPLE_SQUAD: ExampleSquad = {
  a: { name: 'Nori', account: 'kim_kkl' },
  b: { name: '变态猴', account: 'SG_LabmemNo004' },
  c: { name: 'Arthur', account: 'SG_LabmemNo007' },
  d: { name: '打工战士' },
};

const fill = (template: string, squad: ExampleSquad): string =>
  template.replace(/\{\{([abcd])\.(name|account)\}\}/gu, (_all, who: 'a' | 'b' | 'c' | 'd', field: 'name' | 'account') =>
    field === 'account' ? (squad[who] as { account?: string }).account ?? '' : squad[who].name,
  );

/** Worked examples in a squad's voice, one per answer type that has one. */
export interface PubgReplyExamples {
  stats?: string;
  teamDamage?: string;
}

/** The Kurisu worked examples about the given squad (the voice and layout are the same for every squad). */
export function kurisuReplyExamples(squad: ExampleSquad = LAB_EXAMPLE_SQUAD): PubgReplyExamples {
  return { stats: fill(STATS_TEMPLATE, squad), teamDamage: fill(TEAM_DAMAGE_TEMPLATE, squad) };
}

/** Lab's examples (Kurisu, about Lab's squad): the default voice. */
export const KURISU_REPLY_EXAMPLES: PubgReplyExamples = kurisuReplyExamples();

/** The shared guide for the result, followed by the given worked example when one exists for its type. */
export function replyGuideWith(examples: PubgReplyExamples): (presentation: PubgPresentation) => string | undefined {
  return (presentation) => {
    const guide = pubgReplyGuide(presentation);
    if (!guide || presentation.status === 'error' || presentation.status === 'no_matches') return guide;
    const example = presentation.type === 'pubg_stats' ? examples.stats : presentation.type === 'pubg_team_damage' ? examples.teamDamage : undefined;
    return example ? `${guide}\n\n${example}` : guide;
  };
}

/** The shared guide for the result, followed by this squad's worked example when one exists for its type. */
export const replyGuideFor = replyGuideWith(KURISU_REPLY_EXAMPLES);
