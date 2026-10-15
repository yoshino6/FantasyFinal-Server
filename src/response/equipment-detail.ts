import { equipmentSections } from '../game/equipment-detail-format';
import { Format, logger, useEvent, useRoute } from 'alemonjs';
import { useGameMessage as useMessage } from '../game/use-game-message';
import { equipmentDetail, equippedEquipmentDetails } from '../game/adventure.service';
import { messageFormat } from '../game/message';
import { equipmentSlotName, type EquipmentSlot } from '../config/monster-cards';

const slotNames: Record<string, string> = { weapon: '武器', offhand: '副手', shoulder: '头肩', upper: '上装', waist: '腰部', lower: '下装', feet: '脚部', necklace: '项链', bracelet: '手镯', ring: '戒指' };
type EquipmentEnchantmentView = { cardCode: string; cardVersion: number; cardName: string; effectText: string; effects: Record<string, unknown>; allowedSlots: string[] };
type EquipmentDetailItem = Omit<Awaited<ReturnType<typeof equipmentDetail>>, 'fusionEffects'> & {
  enchantment?: EquipmentEnchantmentView | null;
  fusionEffects?: Array<{ materialName: string; key: string; value: number; createdAt: Date }>;
};

const enchantmentSlotText = (enchantment: EquipmentEnchantmentView) => enchantment.allowedSlots
  .map(slot => equipmentSlotName(slot as EquipmentSlot))
  .filter(Boolean)
  .join(' / ') || '未知';

const detailMarkdown = (item: EquipmentDetailItem, heading = '装备详情') => {
  const sections = equipmentSections(item.effect_json, Number(item.quality), item.forge_primary_json, item.item_category, item.weapon_type);
  const isArmor = ['头肩', '上装', '腰部', '下装', '脚部'].includes(item.item_category);
  const typeText = isArmor ? `装备部位：${item.item_category}` : `装备类型：${item.weapon_type ?? '通用'}`;
  const markdown = Format.createMarkdown()
    .addTitle(heading)
    .addNewline()
    .addNewline()
    .addText(`[${item.item_category}]${item.name}\n${typeText}\n装备等级：Lv.${item.required_level}\n品质：${item.rarity}${Number(item.quality).toFixed(1)}%\n耐久：${item.durability}/${item.durability_max}\n\n装备属性：`)
    .addNewline();
  for (const attribute of sections.attributes.length ? sections.attributes : ['无']) markdown.addBlockquote(attribute).addNewline();
  markdown.addNewline().addText('特殊属性：').addNewline();
  for (const effect of sections.effects.length ? sections.effects : ['无']) markdown.addBlockquote(effect.replaceAll('$', '\\$').replaceAll('#', '\\#')).addNewline();
  markdown.addNewline().addText('附魔：').addNewline();
  if (item.enchantment) markdown.addBlockquote(`${item.enchantment.cardName}（版本 ${item.enchantment.cardVersion}）
可附魔部位：${enchantmentSlotText(item.enchantment)}
${item.enchantment.effectText}`.replaceAll('$', '\\$').replaceAll('#', '\\#')).addNewline();
  else markdown.addBlockquote('无').addNewline();
  const fusionLabels: Record<string, string> = { hpMax:'生命',mpMax:'魔力',physicalAttack:'物攻',magicAttack:'魔攻',physicalDefense:'物防',magicDefense:'魔防',accuracy:'命中',evasion:'闪避',critRateBp:'暴击',critDamageBp:'暴伤',critResistBp:'暴免',critDamageReductionBp:'暴抗',tenacity:'韧性',tenacityPierce:'破韧',speed:'速度',hpPct:'生命',mpPct:'魔力',physicalAttackPct:'物攻',magicAttackPct:'魔攻',physicalDefensePct:'物防',magicDefensePct:'魔防',accuracyPct:'命中',evasionPct:'闪避',critRatePct:'暴击',critDamagePct:'暴伤',critResistPct:'暴免',critDamageReductionPct:'暴抗',tenacityPct:'韧性',tenacityPiercePct:'破韧',speedPct:'速度',damageBonusPct:'造成伤害',constitutionPct:'体质',spiritPct:'精神',strengthPct:'力量',intelligencePct:'智力',agilityPct:'敏捷',perceptionPct:'感知' };
  const fusionText = (entry: { materialName: string; key: string; value: number }) => { const label = fusionLabels[entry.key] ?? (entry.key.startsWith('elementMastery_') ? `${entry.key.slice('elementMastery_'.length)}元素精通` : entry.key.startsWith('elementResistance_') ? `${entry.key.slice('elementResistance_'.length)}元素抗性` : entry.key); return `${entry.materialName}：${label}+${Number(entry.value).toFixed(2)}${entry.key.endsWith('Pct') ? '%' : ''}`; };
  if (item.fusionEffects?.length) {
    markdown.addNewline().addText('旧版熔铸遗留：').addNewline();
    for (const effect of item.fusionEffects) markdown.addBlockquote(fusionText(effect)).addNewline();
  }
  return markdown.addNewline().addText('简介：').addNewline().addBlockquote(item.description);
};

export default async () => {
  const [event] = useEvent(); const [route] = useRoute(); const [message] = useMessage();
  try {
    const item = await equipmentDetail(event.current.UserId, Number(route.param('id')));
    await message.send({ format: Format.create().addMarkdown(detailMarkdown(item)) });
  } catch (error) {
    logger.warn({ err: error, userId: event.current.UserId }, 'load equipment detail failed');
    await message.send({ format: messageFormat('装备详情', error instanceof Error ? error.message : '请稍后重试。') });
  }
};

export const equippedEquipmentDetailHandler = async () => {
  const [event] = useEvent(); const [message] = useMessage();
  try {
    const items = await equippedEquipmentDetails(event.current.UserId);
    if (!items.length) throw new Error('当前没有已装备的物品。');
    const actualAttributes = (item: EquipmentDetailItem) => {
      const attributes = equipmentSections(item.effect_json, Number(item.quality), item.forge_primary_json, item.item_category, item.weapon_type).attributes;
      const actualText = (attribute: string) => attribute.replace(/^(.+?) 原始\+.+?｜实际\+(.+?)\((?:主|副)\)$/u, '$1+$2');
      return {
        primary: attributes.filter(attribute => attribute.endsWith('(主)')).map(actualText),
        secondary: attributes.filter(attribute => attribute.endsWith('(副)')).map(actualText)
      };
    };
    const marks = '①②③④⑤⑥⑦⑧⑨⑩';
    const markdown = Format.createMarkdown().addTitle('装备详情').addNewline().addNewline();
    for (const [index, item] of items.entries()) {
      const attributes = actualAttributes(item);
      markdown.addText(`${marks.charAt(index) || `${index + 1}.`}【${slotNames[item.slot] ?? item.slot}】`).addNewline()
        .addBlockquote(`主属性：${attributes.primary.join('、') || '无'}`).addNewline()
        .addBlockquote(`副属性：${attributes.secondary.join('、') || '无'}`).addNewline()
        .addBlockquote(`附魔：${item.enchantment ? `${item.enchantment.cardName}｜可附魔部位：${enchantmentSlotText(item.enchantment)}｜${item.enchantment.effectText}` : '无'}`.replaceAll('$', '\\$').replaceAll('#', '\\#')).addNewline();
    }
    await message.send({ format: Format.create().addMarkdown(markdown).addButtonGroup(Format.createButtonGroup().addRow().addButton('返回装备', '/装备', { type: 'command', autoEnter: false })) });
  } catch (error) {
    logger.warn({ err: error, userId: event.current.UserId }, 'load equipped equipment detail failed');
    await message.send({ format: messageFormat('装备详情', error instanceof Error ? error.message : '请稍后重试。') });
  }
};
