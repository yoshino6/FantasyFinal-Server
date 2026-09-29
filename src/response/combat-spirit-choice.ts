import { Format, useEvent, useRoute } from 'alemonjs';
import { selectCombatSpirit } from '../game/adventure.service';
import { messageFormat } from '../game/message';
import { spiritDefinitions } from '../game/spirit-summoner.config';
import { useGameMessage as useMessage } from '../game/use-game-message';

/** 只选择下一次「召灵」的灵体，实际召唤仍需消耗一次战斗行动。 */
export const combatSpiritChoiceHandler = async () => {
  const [event] = useEvent();
  const [route] = useRoute();
  const [message] = useMessage();
  try {
    const code = String(route.param('spirit') ?? '').trim();
    if (code) {
      const selected = await selectCombatSpirit(event.current.UserId, code);
      await message.send({ format: Format.create().addMarkdown(Format.createMarkdown()
        .addTitle('灵位选择').addNewline().addNewline()
        .addText(`已选定【${selected.name}】。下一次使用「召灵」时，将按当前灵位数量消耗魔力并召唤它；选择本身不消耗行动。`))
        .addButtonGroup(Format.createButtonGroup().addRow().addButton('技能列表', '/技能列表', { type: 'command', autoEnter: false, style: 'blue' })) });
      return;
    }
    const markdown = Format.createMarkdown().addTitle('选择召灵').addNewline().addNewline()
      .addText('选定一只灵体后，再于本场战斗使用「召灵」。最多维持三个灵位；选择不会立即召唤。').addNewline();
    const buttons = Format.createButtonGroup();
    for (let index = 0; index < spiritDefinitions.length; index += 1) {
      if (index % 3 === 0) buttons.addRow();
      const spirit = spiritDefinitions[index];
      markdown.addBlockquote(`【${spirit.name}】${spirit.role}`).addNewline();
      buttons.addButton(spirit.name, `/灵体选择 ${spirit.code}`, { type: 'command', autoEnter: false, style: 'blue' });
    }
    await message.send({ format: Format.create().addMarkdown(markdown).addButtonGroup(buttons) });
  } catch (error) {
    await message.send({ format: messageFormat('灵位选择', error instanceof Error ? error.message : '请稍后重试。') });
  }
};
