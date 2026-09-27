import { Format } from 'alemonjs';
import type { CoreMessage } from './contracts';

type SerializedNode = { type?: string; value?: unknown; options?: Record<string, unknown> };

const stringValue = (value: unknown) => String(value ?? '');
const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const appendMarkdownNode = (markdown: ReturnType<typeof Format.createMarkdown>, node: SerializedNode) => {
  const value = node.value;
  const options = recordValue(node.options);
  switch (node.type) {
    case 'MD.content': markdown.addContent(stringValue(value)); break;
    case 'MD.text': markdown.addText(stringValue(value)); break;
    case 'MD.title': markdown.addTitle(stringValue(value)); break;
    case 'MD.subtitle': markdown.addSubtitle(stringValue(value)); break;
    case 'MD.bold': markdown.addBold(stringValue(value)); break;
    case 'MD.italic': markdown.addItalic(stringValue(value)); break;
    case 'MD.italicStar': markdown.addItalicStar(stringValue(value)); break;
    case 'MD.strikethrough': markdown.addStrikethrough(stringValue(value)); break;
    case 'MD.link': {
      const link = recordValue(value);
      markdown.addLink(stringValue(link.text), typeof link.url === 'string' ? link.url : undefined);
      break;
    }
    case 'MD.image': markdown.addImage(stringValue(value), options as { width?: number; height?: number }); break;
    case 'MD.list': markdown.addList(...(Array.isArray(value) ? value as any[] : [])); break;
    case 'MD.blockquote': markdown.addBlockquote(Array.isArray(value) ? value as any[] : stringValue(value)); break;
    case 'MD.divider': markdown.addDivider(); break;
    case 'MD.newline': markdown.addNewline(Boolean(value)); break;
    case 'MD.code': markdown.addCode(stringValue(value), options as { language?: string }); break;
    case 'MD.mention': markdown.addMention(stringValue(value), options as { belong?: 'user' | 'channel' }); break;
    case 'MD.button': {
      // 所有 QQ 命令按钮都保留为手动输入，避免 qqbot-cmd-enter 的 show 兼容问题。
      markdown.addButton(stringValue(value) || '按钮', { ...options, autoEnter: false } as any);
      break;
    }
    default:
      if (Array.isArray(value)) for (const child of value) appendMarkdownNode(markdown, child as SerializedNode);
      else if (value !== undefined && value !== null) markdown.addContent(stringValue(value));
  }
};

const markdownHasBody = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  return value.some(raw => {
    const node = raw as SerializedNode;
    if (node.type === 'MD.button') return false;
    if (node.type === 'MD.newline' || node.type === 'MD.divider') return true;
    if (node.type === 'MD.list' || node.type === 'MD.blockquote') return Boolean(node.value);
    if (Array.isArray(node.value)) return markdownHasBody(node.value);
    return node.value !== undefined && node.value !== null && stringValue(node.value).length > 0;
  });
};

const markdownHasButtons = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  return value.some(raw => {
    const node = raw as SerializedNode;
    if (node.type === 'MD.button') return true;
    return Array.isArray(node.value) && markdownHasButtons(node.value);
  });
};

const appendButtonGroup = (output: ReturnType<typeof Format.create>, node: SerializedNode): boolean => {
  const rows = node.type === 'BT.row' ? [node] : Array.isArray(node.value) ? node.value : [];
  const group = Format.createButtonGroup();
  const groupOptions = recordValue(node.options);
  if (Object.keys(groupOptions).length) group.setOptions(groupOptions as any);
  let added = false;
  for (const rawRow of rows) {
    const row = rawRow as SerializedNode;
    if (row.type !== 'BT.row' || !Array.isArray(row.value)) continue;
    group.addRow();
    for (const rawButton of row.value) {
      const button = rawButton as SerializedNode;
      if (button.type !== 'Button') continue;
      const options = recordValue(button.options);
      const command = stringValue(options.data ?? options.command ?? '').trim();
      if (!command) continue;
      const { data: _data, command: _command, autoEnter: _autoEnter, ...rest } = options;
      group.addButton(stringValue(button.value) || '按钮', command, { ...rest, type: 'command', autoEnter: false } as any);
      added = true;
    }
  }
  if (added) output.addButtonGroup(group);
  return added;
};

const appendSerializedFormat = (output: ReturnType<typeof Format.create>, nodes: SerializedNode[]) => {
  let hasBody = false;
  let hasButtons = false;
  for (const node of nodes) {
    switch (node.type) {
      case 'Text':
        if (stringValue(node.value)) hasBody = true;
        output.addText(stringValue(node.value), node.options as any);
        break;
      case 'Markdown': {
        const markdown = Format.createMarkdown();
        if (Array.isArray(node.value)) for (const child of node.value) appendMarkdownNode(markdown, child as SerializedNode);
        if (markdownHasBody(node.value)) hasBody = true;
        if (markdownHasButtons(node.value)) hasButtons = true;
        output.addMarkdown(markdown);
        break;
      }
      case 'MarkdownOriginal':
        if (stringValue(node.value)) hasBody = true;
        output.addMarkdownOriginal(stringValue(node.value));
        break;
      case 'Image':
        if (stringValue(node.value)) hasBody = true;
        if (stringValue(node.value)) output.addImage(stringValue(node.value));
        break;
      case 'Mention':
        hasBody = true;
        output.addMention(stringValue(node.value), node.options as any);
        break;
      case 'BT.group':
      case 'BT.row':
        hasButtons = appendButtonGroup(output, node) || hasButtons;
        break;
      case 'Attachment':
        hasBody = true;
        output.addAttachment(stringValue(node.value), node.options as any);
        break;
      case 'Audio':
        hasBody = true;
        output.addAudio(stringValue(node.value));
        break;
      case 'Video':
        hasBody = true;
        output.addVideo(stringValue(node.value));
        break;
      default:
        break;
    }
  }
  return { hasBody, hasButtons };
};

/** QQ 专用渲染器：传输原始 Format.value；没有原始结构时再使用 Markdown 回退。 */
export const renderCoreMessages = (messages: CoreMessage[]) => {
  const output = Format.create();
  let hasBody = false;
  let hasButtons = false;
  for (const message of messages) {
    if (Array.isArray(message.format)) {
      const rendered = appendSerializedFormat(output, message.format);
      hasBody = rendered.hasBody || hasBody;
      hasButtons = rendered.hasButtons || hasButtons;
    } else if (message.kind === 'image' && message.url) {
      output.addImage(message.url);
      hasBody = true;
    } else if (message.kind === 'markdown') {
      const markdown = String(message.markdown ?? message.text ?? '').trim();
      if (markdown) {
        output.addMarkdownOriginal(markdown);
        hasBody = true;
      }
    } else if (message.text) {
      output.addText(message.text);
      hasBody = true;
    }
    if (message.buttons?.length && !hasButtons) {
      const group = Format.createButtonGroup().addRow();
      for (const button of message.buttons) {
        const command = String(button.command ?? '').trim();
        if (command) group.addButton(button.label, command, { type: 'command', autoEnter: false });
      }
      output.addButtonGroup(group);
      hasButtons = true;
    }
  }
  // QQ Markdown 消息必须有正文；旧菜单只有 keyboard 时会返回 40034011。
  if (!hasBody) output.addMarkdownOriginal(hasButtons ? '请选择一个操作：' : '暂无可显示内容。');
  return output;
};

export const renderCoreError = (error: unknown) => Format.create().addText(error instanceof Error ? error.message : '游戏核心暂时不可用，请稍后再试。');
