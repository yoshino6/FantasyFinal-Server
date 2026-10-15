import { Format, useEvent, useRoute } from 'alemonjs';
import { useGameMessage as useMessage, withoutAutomatonInteractions } from '../game/use-game-message';
import { messageFormat } from '../game/message';
import { durationText } from '../game/time-format';
import type { EnvironmentJobView, EnvironmentObjectView } from '../game/map-environment.service';

export const environmentJobFormat = (job: EnvironmentJobView | null, notice = '') => {
  const markdown = Format.createMarkdown().addTitle('环境清理').addNewline().addNewline();
  if (notice) markdown.addText(notice).addNewline().addNewline();
  const buttons = Format.createButtonGroup().addRow();
  if (job) {
    markdown.addText(`正在清理：${job.objectName}`).addNewline()
      .addText(job.ready ? '作业已到期，系统正在结算，也可手动结算；结算前障碍仍保留。' : `剩余${durationText(job.remainingSeconds)}；完成前障碍仍保留。`);
    buttons.addButton('刷新清理', '/刷新清理', { type: 'command', autoEnter: false });
    if (job.ready) buttons.addButton('结算清理', `/结算清理 ${job.objectId}`, { type: 'command', autoEnter: false, style: 'blue' });
    buttons.addButton('取消清理', '/取消清理', { type: 'command', autoEnter: false });
  } else markdown.addText('当前没有正在进行的环境清理。');
  buttons.addButton('操作面板', '/面板', { type: 'command', autoEnter: false });
  return Format.create().addMarkdown(markdown).addButtonGroup(buttons);
};

export const environmentObjectFormat = (object: EnvironmentObjectView) => {
  const markdown = Format.createMarkdown().addTitle(object.name).addNewline().addNewline()
    .addBlockquote(object.description).addNewline().addNewline()
    .addText(`占地：${object.width}×${object.height} 格｜${object.blocking ? '阻挡通行' : '不影响通行'}`).addNewline()
    .addText(object.destructible ? `清理耗时：${durationText(object.workSeconds)}` : '无法清理，请沿可通行方向绕行。');
  if (object.clearReason) markdown.addNewline().addText(object.clearReason);
  const buttons = Format.createButtonGroup().addRow();
  if (object.canClear) buttons.addButton('清理景物', `/清理景物 ${object.id}`, { type: 'command', autoEnter: false, style: 'blue' });
  if (object.ownedJob) buttons.addButton('刷新清理', '/刷新清理', { type: 'command', autoEnter: false });
  buttons.addButton('操作面板', '/面板', { type: 'command', autoEnter: false });
  return Format.create().addMarkdown(markdown).addButtonGroup(buttons);
};

export const mapEnvironmentHandler = (action: 'inspect' | 'start' | 'status' | 'settle' | 'cancel') => async () => {
  const [event] = useEvent(); const [route] = useRoute(); const [rawMessage] = useMessage();
  const message = action === 'status' || action === 'inspect' ? withoutAutomatonInteractions(rawMessage) : rawMessage;
  const user = event.current.UserId;
  try {
    const service = await import('../game/map-environment.service');
    const objectId = String(route.param('id') ?? '').trim();
    if (action === 'inspect') {
      if (!objectId) throw new Error('请指定需要查看的景物编号。');
      const view = await service.environmentInspect(user, objectId);
      await message.send({ format: environmentObjectFormat(view.objects[0]!) });
      return;
    }
    if (action === 'status') {
      // 刷新只读进度，绝不顺便清除障碍或发放物品。
      const view = await service.environmentStatus(user);
      await message.send({ format: environmentJobFormat(view.job) });
      return;
    }
    const result = action === 'start'
      ? await service.environmentStartClear(user, objectId)
      : action === 'cancel'
        ? await service.environmentCancelClear(user)
        : await service.environmentFinishClear(user, objectId || undefined);
    const format = environmentJobFormat('job' in result ? result.job : null, result.message);
    if (!('job' in result)) {
      try {
        const { movementButtons } = await import('./adventure');
        format.addButtonGroup(await movementButtons(user));
      } catch { /* 已提交的清理结果仍然显示，玩家可用“操作面板”重新读取方向。 */ }
    }
    await message.send({ format });
  } catch (error) {
    await message.send({ format: messageFormat('环境清理', error instanceof Error ? error.message : '操作失败，请刷新后重试。') });
  }
};
