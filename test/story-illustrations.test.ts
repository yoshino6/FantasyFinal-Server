import assert from 'node:assert/strict';
import test from 'node:test';
import { Format } from 'alemonjs';
import { addStoryIllustration, createStoryIllustrationRegistry, storySceneKeyFromFormat } from '../src/game/story-illustrations';
import { formatValueToButtons, formatValueToText } from '../src/app-api/app-format';
import { createCoreInteractionActionService } from '../src/app-api/interaction-action.service';
import manifest from '../src/assets/game/story/illustrations/manifest.json';

const record = { sceneKey: 'opening.F01.A.branch.2', file: 'f01-rabbit.webp', width: 1536, height: 1024 };

test('bundled scene aliases share one file without selecting an unchosen branch', () => {
  const registry = createStoryIllustrationRegistry([{ ...record, groupKey: 'opening.F01.A', sceneKeys: ['opening.F01.A.branch.3'] }]);
  assert.equal(registry.appImage('opening.F01.A.branch.3')?.path, '/assets/story/f01-rabbit.webp');
  assert.equal(registry.get('opening.F01.A')?.file, record.file);
  assert.equal(registry.appImage('opening.F01.B.branch.2'), undefined);
  assert.equal(registry.appImage('opening.F01.reading.1'), undefined);
});

test('absent gallery URL leaves QQ text and actions intact without a broken image', () => {
  const registry = createStoryIllustrationRegistry([record]);
  const markdown = addStoryIllustration(Format.createMarkdown().addTitle('初章·兔子认识她'), record.sceneKey, registry.get).addText('梨子朝兔子摊开手掌。');
  const format = Format.create().addMarkdown(markdown).addButtonGroup(Format.createButtonGroup().addRow().addButton('继续', '/初行选择 2 next', { type: 'command', autoEnter: false }));
  assert.equal(storySceneKeyFromFormat(format.value), record.sceneKey);
  assert.equal(JSON.stringify(format.value).includes('MD.image'), false);
  assert.match(formatValueToText(format.value), /梨子朝兔子摊开手掌/);
  assert.deepEqual(formatValueToButtons(format.value), [{ label: '继续', command: '/初行选择 2 next' }]);
});

test('a real hosted URL is embedded inside the same story Markdown', () => {
  const registry = createStoryIllustrationRegistry([{ ...record, qqUrl: 'https://gallery.example.test/story/f01-rabbit.webp' }]);
  const markdown = addStoryIllustration(Format.createMarkdown().addTitle('初章·兔子认识她'), record.sceneKey, registry.get).addText('剧情正文');
  const image = (markdown.value.value as { type: string; value: unknown; options?: Record<string, unknown> }[]).find(node => node.type === 'MD.image');
  assert.equal(image?.value, 'https://gallery.example.test/story/f01-rabbit.webp');
  assert.equal(image?.options?.width, 640);
  assert.equal(image?.options?.height, 427);
});

test('invalid paths, duplicate aliases and malformed URLs cannot enter the registry', () => {
  assert.throws(() => createStoryIllustrationRegistry([{ ...record, file: '../private.webp' }]), /无效/);
  assert.throws(() => createStoryIllustrationRegistry([{ ...record, qqUrl: 'javascript:alert(1)' }]), /图库地址无效/);
  assert.throws(() => createStoryIllustrationRegistry([record, { ...record, sceneKey: 'another.scene', sceneKeys: [record.sceneKey] }]), /编号重复/);
});

test('Core story capture retains the bundled image DTO while signing the original choice', async context => {
  const image = manifest.scenes.find(scene => scene.qqUrl);
  if (!image) { context.skip('尚无已上传并发布的剧情图'); return; }
  const markdown = addStoryIllustration(Format.createMarkdown().addTitle('初章·相遇'), image.sceneKey).addText('原有剧情正文。');
  const format = Format.create().addMarkdown(markdown).addButtonGroup(Format.createButtonGroup().addRow().addButton('继续', '/初行选择 2 next', { type: 'command', autoEnter: false }));
  const service = createCoreInteractionActionService({ resolveQqUser: async () => 'app_story_test', publicCoreCommands: () => [{ command: '注册' }] });
  const response = await service.issue({ session: { playerId: 1, characterId: 1, loginId: 'H-1', gameUserId: 'story_test', displayName: '剧情测试', passwordLoginEnabled: true }, sessionToken: 'story-session-test-credential', originCommand: '/注册', execution: { matched: true, result: {}, formats: [format.value] } });
  assert.equal(response.messages[0]?.storyImage?.path, `/assets/story/${image.file}`);
  assert.equal(response.messages[0]?.storyImage?.sceneKey, image.sceneKey);
  assert.equal(response.messages[0]?.buttons.length, 1);
  assert.equal(JSON.stringify(response.messages).includes('/初行选择'), false);
  assert.equal(JSON.stringify(response.messages[0]?.format).includes(image.qqUrl!), true);
});
