import type { Format } from 'alemonjs';

export type AppButton = { label: string; command: string };
/** 可跨进程传输的 Alemon Format 节点。Format.value 本身是 JSON 数据，不能把构建器实例传给桌宠或 QQ。 */
export type AppFormatNode = { type?: string; value?: unknown; options?: Record<string, unknown> };
export type AppMapData = {
  current?: { name: string; x: number; y: number; z: number };
  maps: {
    code: string;
    name: string;
    danger: number;
    isCurrent: boolean;
    /** 仅供网页地图概览绘制边界，不影响移动校验。 */
    bounds?: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  }[];
  /** 当前角色与同队成员的实际区域和坐标；不包含其他玩家。 */
  partyMembers?: {
    id: number;
    gameId: number;
    name: string;
    isLeader: boolean;
    isSelf: boolean;
    regionCode: string;
    regionName: string;
    x: number;
    y: number;
    z: number;
  }[];
  /** 当前角色所在区域以及队友所在区域的可见关键坐标。 */
  landmarks?: {
    code: string;
    name: string;
    type: 'building' | 'landmark';
    regionCode: string;
    regionName: string;
    x: number;
    y: number;
    z: number;
  }[];
};
export type AppMessage = {
  text: string;
  /** 给桌宠或没有结构化 Format 的客户端使用的 Markdown 回退内容。 */
  markdown?: string;
  /** 原始 Format.value，QQ 端会按 Alemon 节点重新构造 Format。 */
  format?: AppFormatNode[];
  buttons: AppButton[];
  petReply?: string;
  mapData?: AppMapData;
};

type FormatNode = AppFormatNode;

const mdNodeToText = (node: FormatNode): string => {
  const value = node.value;
  switch (node.type) {
    case 'MD.title':
      return `【${String(value ?? '')}】\n`;
    case 'MD.subtitle':
      return `— ${String(value ?? '')} —\n`;
    case 'MD.text':
    case 'MD.content':
      return String(value ?? '');
    case 'MD.bold':
      return `**${String(value ?? '')}**`;
    case 'MD.italic':
      return `*${String(value ?? '')}*`;
    case 'MD.italicStar':
      return `*${String(value ?? '')}*`;
    case 'MD.strikethrough':
      return `~~${String(value ?? '')}~~`;
    case 'MD.blockquote':
      return Array.isArray(value)
        ? `> ${formatValueToText(value).replace(/\r?\n/g, '\n> ')}`
        : `> ${String(value ?? '').replace(/\r?\n/g, '\n> ')}`;
    case 'MD.code':
      return `\`${String(value ?? '')}\``;
    case 'MD.link':
      return String((value as { text?: string })?.text ?? '');
    case 'MD.image':
      return value ? `[图片]` : '';
    case 'MD.mention':
      return `@${String(value ?? '')}`;
    case 'MD.list':
      return Array.isArray(value) ? value.map(item => {
        const listItem = item as { value?: unknown };
        if (listItem && typeof listItem === 'object' && 'value' in listItem) {
          const itemValue = listItem.value;
          if (itemValue && typeof itemValue === 'object') {
            const indexed = itemValue as { index?: unknown; text?: unknown };
            return `${indexed.index ?? ''}. ${String(indexed.text ?? '')}`.trim();
          }
          return `- ${String(itemValue ?? '')}`;
        }
        return `- ${String(item ?? '')}`;
      }).join('\n') : '';
    case 'MD.newline':
      return '\n';
    case 'MD.divider':
      return '\n——————————\n';
    default:
      return '';
  }
};

const markdownToText = (nodes: unknown): string => {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(node => {
    const item = node as FormatNode;
    if (Array.isArray(item.value)) return markdownToText(item.value);
    return mdNodeToText(item);
  }).join('');
};

export const formatValueToText = (formatValue: unknown): string => {
  if (!Array.isArray(formatValue)) return '';
  const parts = formatValue.map(node => {
    const item = node as FormatNode;
    if (item.type === 'Text') return String(item.value ?? '');
    if (item.type === 'Markdown') return markdownToText(item.value);
    if (item.type === 'MarkdownOriginal') return String(item.value ?? '');
    if (item.type === 'Image') return item.value ? '[图片]' : '';
    if (item.type === 'BT.group') return '';
    return '';
  });
  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const markdownNodeToMarkdown = (node: FormatNode): string => {
  const value = node.value;
  switch (node.type) {
    case 'MD.title':
      return `# ${String(value ?? '')} `;
    case 'MD.subtitle':
      return `## ${String(value ?? '')} `;
    case 'MD.text':
    case 'MD.content':
      return String(value ?? '');
    case 'MD.bold':
      return `**${String(value ?? '')}** `;
    case 'MD.italic':
      return `__${String(value ?? '')}__ `;
    case 'MD.italicStar':
      return `*${String(value ?? '')}* `;
    case 'MD.strikethrough':
      return `~~${String(value ?? '')}~~ `;
    case 'MD.link': {
      const link = value as { text?: unknown; url?: unknown } | undefined;
      if (!link?.text && !link?.url) return '';
      if (!link?.text || !link?.url) return `<${String(link.url ?? link.text)}> `;
      return `[🔗${String(link.text)}](${String(link.url)}) `;
    }
    case 'MD.image': {
      const url = String(value ?? '').trim();
      if (!url) return '';
      const options = node.options ?? {};
      const width = Number(options.width) || 208;
      const height = Number(options.height) || 320;
      return `\n![text #${width}px #${height}px](${url})\n`;
    }
    case 'MD.list':
      return Array.isArray(value) ? `${value.map(item => {
        const listItem = item as { value?: unknown };
        const itemValue = listItem && typeof listItem === 'object' && 'value' in listItem ? listItem.value : item;
        if (itemValue && typeof itemValue === 'object') {
          const indexed = itemValue as { index?: unknown; text?: unknown };
          return `\n${indexed.index ?? 1}. ${String(indexed.text ?? '')}`;
        }
        return `\n- ${String(itemValue ?? '')}`;
      }).join('')}\n` : '';
    case 'MD.blockquote':
      return Array.isArray(value)
        ? `> ${formatValueToMarkdown(value).replace(/\r?\n/g, '\n> ')}`
        : `> ${String(value ?? '').replace(/\r?\n/g, '\n> ')}`;
    case 'MD.divider':
      return '\n***\n';
    case 'MD.newline':
      return '\n';
    case 'MD.code': {
      const language = typeof node.options?.language === 'string' ? node.options.language : '';
      return `\n\`\`\`${language}\n${String(value ?? '')}\n\`\`\`\n`;
    }
    case 'MD.mention':
      return value === 'everyone' ? '<qqbot-at-everyone />' : `<qqbot-at-user id="${String(value ?? '')}" />`;
    case 'MD.button': {
      // 回退正文不生成蓝色直达链接；命令由 buttons DTO 或结构化 Format 负责手动输入。
      return String(value ?? '');
    }
    default:
      return Array.isArray(value) ? formatValueToMarkdown(value) : String(value ?? '');
  }
};

/** 将 Alemon 的结构化 Markdown 转为客户端可理解的原始 Markdown 回退。 */
export const formatValueToMarkdown = (formatValue: unknown): string => {
  if (!Array.isArray(formatValue)) return '';
  return formatValue.map(node => {
    const item = node as FormatNode;
    if (item.type === 'Text') return String(item.value ?? '');
    if (item.type === 'Markdown') return formatValueToMarkdown(item.value);
    if (item.type === 'MarkdownOriginal') return String(item.value ?? '');
    if (item.type === 'Image') return item.value ? `\n![图片](${String(item.value)})\n` : '';
    if (item.type === 'Mention') return item.value === 'everyone' ? '<qqbot-at-everyone />' : `<qqbot-at-user id="${String(item.value ?? '')}" />`;
    if (item.type === 'BT.group' || item.type === 'BT.row' || item.type === 'Select') return '';
    return markdownNodeToMarkdown(item);
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
};

const commandFrom = (options: unknown, fallback?: string): string => {
  const value = options as Record<string, unknown> | undefined;
  const data = value?.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  // 不同 Format 版本可能把按钮命令放在 command/value 中；App 按钮必须始终带可执行命令。
  if (typeof value?.command === 'string' && value.command.trim()) return value.command.trim();
  if (typeof value?.value === 'string' && value.value.trim().startsWith('/')) return value.value.trim();
  return String(fallback ?? '').trim();
};

export const formatValueToButtons = (formatValue: unknown): AppButton[] => {
  if (!Array.isArray(formatValue)) return [];
  const buttons: AppButton[] = [];
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const node of value) {
      const item = node as FormatNode;
      if (item.type === 'BT.group' || item.type === 'BT.row') {
        visit(item.value);
        continue;
      }
      if (item.type === 'Button') {
        const command = commandFrom(item.options);
        if (command) buttons.push({ label: String(item.value ?? '按钮'), command });
        continue;
      }
      if (item.type === 'MD.button') {
        const command = commandFrom(item.options);
        if (command) buttons.push({ label: String(item.value ?? '按钮'), command });
        continue;
      }
      if (item.type === 'Markdown' || item.type === 'MD.row') visit(item.value);
    }
  };
  visit(formatValue);
  return buttons;
};

export const formatToAppMessage = (format: Format, petReply?: string): AppMessage => ({
  text: formatValueToText(format.value),
  markdown: formatValueToMarkdown(format.value),
  format: Array.isArray(format.value) ? format.value as AppFormatNode[] : undefined,
  buttons: formatValueToButtons(format.value),
  petReply
});

export const formatValueToAppMessage = (formatValue: unknown, petReply?: string): AppMessage => ({
  text: formatValueToText(formatValue),
  markdown: formatValueToMarkdown(formatValue),
  format: Array.isArray(formatValue) ? formatValue as AppFormatNode[] : undefined,
  buttons: formatValueToButtons(formatValue),
  petReply
});

export const plainAppMessage = (text: string, buttons: AppButton[] = [], petReply?: string): AppMessage => ({
  text: text.trim(),
  markdown: text.trim() || (buttons.length ? '请选择一个操作：' : undefined),
  buttons,
  petReply
});
