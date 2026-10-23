import type { PubgPresentation } from './contracts/pubg.js';

/*
 * How an agent should retell each kind of PUBG answer, shared by every product that hands a PUBG result to a model.
 * The guide travels inside the tool result, next to the facts, because a lazily loaded skill is not reliably read.
 * Guides describe shape only: every number comes from displayText, and voice/persona stay with each product's own
 * prompt. A product may append its own worked example.
 */

export const STATS_REPLY_GUIDE = [
  '这是一份战绩查询结果。回复就是一份完整战报，按下面的结构写，不要压缩成一行一人的短列表：',
  '1. 开场一两句人设口吻：按称呼名册点名提问的人，评论这段时间的局数、吃鸡或最亮眼的数字。',
  '2. 原样保留 displayText 的标题行（🏆 …）。',
  '3. 每个队员一张卡，顺序和勋章（🥇🥈🥉🎖️，按 K/D 排）与 displayText 一致，不要自己重排：',
  '   - 名字行：可在名字前加一个贴切的外号，名字换成名册里的称呼，括号保留 PUBG 账号。',
  '   - 「• 出战 N 局：…」和「• 个人数据：…」两行逐字照抄，数字、称号（全队助攻王 / 全队伤害第一 / 破点王 / 全队救援王）和 **加粗** 一个不能少。',
  '   - 再加一行「• AI 锐评：…」，一两句毒舌或夸奖，只引用这个人卡片上的真实数字。',
  '4. 「团队合计：…」一行原样保留并加粗。',
  '5. 收尾一两句吐槽，点名谁 carry、谁死得最多或谁拉人最多，落在称呼上。',
  '6. displayText 最后如果有 🔗 分享链接，原样放在回复最后一行。',
  '不得编造数字、外号以外的事实或 displayText 里没有的称号。',
].join('\n');

export const TEAM_DAMAGE_REPLY_GUIDE = [
  '这是一份队内误伤（队友互相伤害）账本。回复写成完整的「对账」战报，不要压缩成几行短列表：',
  '1. 开场一两句人设口吻：点名提问的人，接上他刚说的话或当天的梗。',
  '2. 总账：保留 displayText 的总误伤、总命中和括号里的分类（飞踢 / 重拳 / 载具撞击 / 走火）。',
  '3. 「互相伤害明细」逐条保留每个方向：名字换成名册称呼、括号保留 PUBG 账号，可以给方向起一个小标题；',
  '   每条下面保留「总输出：N 次命中，造成 X 伤害（分类）」，再补一句只引用这条数字的吐槽。',
  '   两个人互相打时，算出两人对攻合计和占全队误伤的比例（只用 displayText 的数字计算）。',
  '4. 有「名场面」时原样保留每一局的局号、地图、名次和每个方向的次数与伤害，再加一句画面感的描述（不要编位置、时机等数据里没有的细节）。',
  '5. 有清白名单时点名表扬一句（0 次主动队内输出）。',
  '6. 总结两三句：谁是内耗核心、谁挨打最多，落在称呼上收尾。',
  '没有任何方向时，直接说这段时间没有队内误伤记录，不要编。数据不完整时说明哪些未知，不要把未知当 0。',
].join('\n');

export const MATCH_LIST_REPLY_GUIDE = [
  '这是一份对局列表。回复保留 displayText 里每一局的序号、时间、地图、名次和每个人的击杀 / 伤害，名字换成名册称呼；',
  '开场一两句点名提问的人，结尾一两句点评（哪局最好、哪局最惨、谁最稳），只引用列表里的数字。',
  '如果用户是在问「只看四排 / 去掉双排后的 KD」这类问题，先说明列表的筛选条件，再按列表里的数字逐人算出结果，写清算法（例如 KD = 击杀 ÷ 死亡），不要编死亡数之类列表里没有的数字。',
].join('\n');

export const GENERAL_REPLY_GUIDE = [
  '回复以 displayText 为事实块：保留其中所有数字、名次、称号和链接，名字换成名册称呼；',
  '前后加人设口吻的开场和点评，点评只引用 displayText 里的真实数字，不要把事实块压缩成一两句。',
].join('\n');

export const NO_MATCHES_REPLY_GUIDE =
  '没有找到符合条件的比赛：用人设口吻如实说明查询的时间范围里没有对局（可以吐槽一句），不要编任何数字，也不要拿以前的战绩代替。';
export const PARTIAL_REPLY_GUIDE =
  '数据不完整：照常写回复，但要点明哪些部分缺失或未知；未知不是 0，不要补全或猜测。';
export const ERROR_REPLY_GUIDE =
  '这次查询失败：用一两句如实说明没查到、请稍后再试，不要用聊天记录里的旧数字回答。';

/** The guide for a result, or undefined when the result needs none (internal tools, plain status messages). */
export function pubgReplyGuide(presentation: PubgPresentation): string | undefined {
  if (presentation.status === 'error') return ERROR_REPLY_GUIDE;
  if (presentation.status === 'no_matches') return NO_MATCHES_REPLY_GUIDE;
  const guide =
    presentation.type === 'pubg_stats'
      ? presentation.rows.length
        ? STATS_REPLY_GUIDE
        : undefined
      : presentation.type === 'pubg_team_damage'
        ? TEAM_DAMAGE_REPLY_GUIDE
        : presentation.type === 'pubg_match_list'
          ? MATCH_LIST_REPLY_GUIDE
          : presentation.type === 'pubg_status'
            ? undefined
            : GENERAL_REPLY_GUIDE;
  if (!guide) return undefined;
  return presentation.status === 'partial' ? `${guide}\n${PARTIAL_REPLY_GUIDE}` : guide;
}
