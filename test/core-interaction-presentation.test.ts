import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coreInteractionPresentation, coreWindowCommand } from '../src/app-api/core-interaction-presentation';

test('registration, gifts and opening continuation remain story after the character exists', () => {
  for (const command of ['/注册 继续 audience', '/询问 这里是哪里', '/天堂 继续', '/天赋目录 2', '/选择恩赐 A01', '/初行选择 7 next', '/初章 包容之镇 继续', '/继续剧情']) {
    assert.deepEqual(coreInteractionPresentation(command), { presentation: 'story' }, command);
  }
  assert.deepEqual(coreInteractionPresentation('/天赋'), { presentation: 'interaction' });
});

test('story page exit buttons close the dialog and select the requested main panel', () => {
  assert.deepEqual(coreInteractionPresentation('/角色'), { presentation: 'page', destination: 'character' });
  assert.deepEqual(coreInteractionPresentation('/背包 道具'), { presentation: 'page', destination: 'inventory' });
  assert.deepEqual(coreInteractionPresentation('/面板'), { presentation: 'page', destination: 'explore' });
  assert.deepEqual(coreInteractionPresentation('/战斗'), { presentation: 'page', destination: 'explore' });
});

test('opening middleware scenes take precedence over the intercepted building or exploration command', () => {
  const formats = [[{ type: 'Markdown', value: [{ type: 'MD.title', value: '初章·林间岔路（1/3）' }] }]];
  assert.deepEqual(coreInteractionPresentation('/建筑进入 guild_counter', formats), { presentation: 'story' });
  assert.deepEqual(coreInteractionPresentation('/寻怪', formats), { presentation: 'story' });
  const battle = [[{ type: 'Markdown', value: [{ type: 'MD.title', value: '战斗操作' }] }]];
  assert.deepEqual(coreInteractionPresentation('/初行选择 9 next', battle), { presentation: 'page', destination: 'explore' });
});

test('only explicit building entry commands require a Core window', () => {
  for (const command of ['/建筑进入 guild_counter', '/建筑敲门 hunter_lodge', '/坐标互动 建筑 guild_counter']) {
    assert.equal(coreWindowCommand(command), true);
    assert.deepEqual(coreInteractionPresentation(command), { presentation: 'interaction' });
  }
  for (const command of ['/建筑忽略 guild_counter', '/建筑进入测试', '/购买商品 1 1']) assert.equal(coreWindowCommand(command), false);
});

test('safe commerce menus select the existing quote-based shop, without classifying writes', () => {
  assert.deepEqual(coreInteractionPresentation('/建筑进入 silver_bell_bank'), { presentation: 'interaction', commerce: { kind: 'bank' } });
  assert.deepEqual(coreInteractionPresentation('/商店出售页 2'), { presentation: 'interaction', commerce: { kind: 'guildShop', mode: 'sell' } });
  assert.deepEqual(coreInteractionPresentation('/建筑区域 guild_counter 工会商店'), { presentation: 'interaction', commerce: { kind: 'guildShop', mode: 'buy', targetId: 'guild_counter' } });
  assert.deepEqual(coreInteractionPresentation('/书屋购买搜索 魔法'), { presentation: 'interaction', commerce: { kind: 'bookshop', mode: 'buy' } });
  assert.deepEqual(coreInteractionPresentation('/百纳居'), { presentation: 'interaction', commerce: { kind: 'homeShop' } });
  assert.deepEqual(coreInteractionPresentation('/购买商品 1 1'), { presentation: 'interaction' });
  const story = [[{ type: 'Markdown', value: [{ type: 'MD.title', value: '初章·初行之路' }] }]];
  assert.deepEqual(coreInteractionPresentation('/建筑进入 bookshop', story), { presentation: 'story' });
});
