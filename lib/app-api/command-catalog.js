//#region src/app-api/command-catalog.ts
const arg = (name, label, type, options = {}) => ({
	name,
	label,
	type,
	...options
});
/** 当前 App/H5 命令桥允许公开的玩家命令。不要在这里加入管理或调试命令。 */
const appCommandCatalog = [
	{
		id: "system.menu",
		title: "功能菜单",
		category: "system",
		command: "菜单",
		usage: "/菜单 [进阶]",
		args: [arg("page", "菜单页", "enum", { options: ["核心", "进阶"] })],
		readOnly: true,
		requiresCharacter: false,
		risk: "read",
		refresh: []
	},
	{
		id: "character.profile",
		title: "角色",
		category: "character",
		command: "角色",
		aliases: ["我"],
		usage: "/角色",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["summary"]
	},
	{
		id: "character.attributes",
		title: "属性",
		category: "character",
		command: "属性",
		usage: "/属性",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["summary"]
	},
	{
		id: "character.talent",
		title: "天赋",
		category: "character",
		command: "天赋",
		usage: "/天赋",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["summary"]
	},
	{
		id: "character.profession",
		title: "职业",
		category: "character",
		command: "职业",
		usage: "/职业",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["summary"]
	},
	{
		id: "inventory.list",
		title: "背包",
		category: "inventory",
		command: "背包",
		aliases: ["物品"],
		usage: "/背包 [装备|道具|材料]",
		args: [arg("category", "分类", "enum", { options: [
			"装备",
			"道具",
			"材料"
		] })],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["inventory"]
	},
	{
		id: "explore.nearby",
		title: "探索",
		category: "explore",
		command: "探索",
		aliases: ["寻怪"],
		usage: "/探索",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["summary", "nearby"]
	},
	{
		id: "battle.choose-target",
		title: "选择目标",
		category: "battle",
		command: "目标",
		usage: "/目标 <编号>",
		args: [arg("id", "目标编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "combat",
		refresh: ["summary", "battle"]
	},
	{
		id: "battle.switch-target",
		title: "切换战斗目标",
		category: "battle",
		command: "切换目标",
		usage: "/切换目标 <编号>",
		args: [arg("id", "战斗目标编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "combat",
		refresh: ["battle"]
	},
	{
		id: "battle.negotiation",
		title: "交涉",
		category: "battle",
		command: "交涉",
		usage: "/交涉 <怪物编号>",
		args: [arg("id", "怪物编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: [
			"summary",
			"battle",
			"inventory"
		]
	},
	{
		id: "battle.negotiation-action",
		title: "交涉行动",
		category: "battle",
		command: "交涉行动",
		usage: "/交涉行动 <怪物编号> <会话编号> <版本> <交谈|开战|离开>",
		args: [
			arg("id", "怪物编号", "number", {
				required: true,
				min: 1
			}),
			arg("session", "会话编号", "text", { required: true }),
			arg("revision", "交涉版本", "number", {
				required: true,
				min: 0
			}),
			arg("action", "行动", "enum", {
				required: true,
				options: [
					"交谈",
					"开战",
					"离开"
				]
			})
		],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: [
			"summary",
			"battle",
			"inventory"
		]
	},
	{
		id: "battle.negotiation-item",
		title: "选择交涉物品",
		category: "battle",
		command: "交涉物品",
		usage: "/交涉物品 <怪物编号> <会话编号> <版本> <物品编号> [数量]",
		args: [
			arg("id", "怪物编号", "number", {
				required: true,
				min: 1
			}),
			arg("session", "会话编号", "text", { required: true }),
			arg("revision", "交涉版本", "number", {
				required: true,
				min: 0
			}),
			arg("item", "物品编号", "number", {
				required: true,
				min: 1
			}),
			arg("quantity", "数量", "number", { min: 1 })
		],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: [
			"summary",
			"battle",
			"inventory"
		]
	},
	{
		id: "battle.negotiation-gift",
		title: "确认交涉交付",
		category: "battle",
		command: "交涉交付",
		usage: "/交涉交付 <怪物编号> <会话编号> <版本> <物品编号> <数量>",
		args: [
			arg("id", "怪物编号", "number", {
				required: true,
				min: 1
			}),
			arg("session", "会话编号", "text", { required: true }),
			arg("revision", "交涉版本", "number", {
				required: true,
				min: 0
			}),
			arg("item", "物品编号", "number", {
				required: true,
				min: 1
			}),
			arg("quantity", "数量", "number", {
				required: true,
				min: 1
			})
		],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: [
			"summary",
			"battle",
			"inventory"
		]
	},
	{
		id: "battle.negotiation-page",
		title: "交涉分页",
		category: "battle",
		command: "交涉分页",
		usage: "/交涉分页 <怪物编号> <会话编号> <页码> [关键词]",
		args: [
			arg("id", "怪物编号", "number", {
				required: true,
				min: 1
			}),
			arg("session", "会话编号", "text", { required: true }),
			arg("page", "页码", "number", {
				required: true,
				min: 1
			}),
			arg("keyword", "关键词", "rest")
		],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["battle", "inventory"]
	},
	{
		id: "battle.negotiation-search",
		title: "搜索交涉物品",
		category: "battle",
		command: "交涉搜索",
		usage: "/交涉搜索 <怪物编号> <会话编号> [关键词]",
		args: [
			arg("id", "怪物编号", "number", {
				required: true,
				min: 1
			}),
			arg("session", "会话编号", "text", { required: true }),
			arg("keyword", "关键词", "rest")
		],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["battle", "inventory"]
	},
	{
		id: "explore.coordinate-interaction",
		title: "坐标互动",
		category: "explore",
		command: "坐标互动",
		usage: "/坐标互动 <类型> <编号>",
		args: [arg("type", "目标类型", "enum", {
			required: true,
			options: [
				"玩家",
				"域民",
				"NPC",
				"建筑",
				"资源",
				"入口",
				"地标"
			]
		}), arg("id", "目标编号", "text", { required: true })],
		readOnly: true,
		requiresCharacter: true,
		risk: "interaction",
		refresh: ["nearby"]
	},
	{
		id: "explore.npc-talk",
		title: "NPC 对话",
		category: "explore",
		command: "NPC对话",
		usage: "/NPC对话 <代码>",
		args: [arg("code", "NPC 代码", "text", { required: true })],
		readOnly: true,
		requiresCharacter: true,
		risk: "interaction",
		refresh: ["nearby", "story"]
	},
	{
		id: "explore.npc-ignore",
		title: "忽略 NPC",
		category: "explore",
		command: "NPC忽略",
		usage: "/NPC忽略 <代码>",
		args: [arg("code", "NPC 代码", "text", { required: true })],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: ["nearby"]
	},
	{
		id: "explore.building-ignore",
		title: "忽略建筑",
		category: "explore",
		command: "建筑忽略",
		usage: "/建筑忽略 <代码>",
		args: [arg("code", "建筑代码", "text", { required: true })],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: ["nearby"]
	},
	{
		id: "explore.building-knock",
		title: "敲门",
		category: "explore",
		command: "建筑敲门",
		usage: "/建筑敲门 <代码>",
		args: [arg("code", "建筑代码", "text", { required: true })],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: ["nearby", "story"]
	},
	{
		id: "explore.building-enter",
		title: "进入建筑",
		category: "explore",
		command: "建筑进入",
		usage: "/建筑进入 <代码>",
		args: [arg("code", "建筑代码", "text", { required: true })],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: ["nearby", "story"]
	},
	{
		id: "explore.mine",
		title: "开采资源",
		category: "explore",
		command: "开采",
		usage: "/开采 <资源编号>",
		args: [arg("id", "资源编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: [
			"summary",
			"inventory",
			"nearby"
		]
	},
	{
		id: "explore.refresh-mining",
		title: "刷新开采",
		category: "explore",
		command: "刷新开采",
		usage: "/刷新开采",
		args: [],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: [
			"summary",
			"inventory",
			"nearby"
		]
	},
	{
		id: "explore.cancel-mining",
		title: "取消开采",
		category: "explore",
		command: "取消开采",
		usage: "/取消开采",
		args: [],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: [
			"summary",
			"inventory",
			"nearby"
		]
	},
	{
		id: "explore.enter-dungeon",
		title: "进入迷宫",
		category: "explore",
		command: "下迷宫",
		usage: "/下迷宫 <入口编号>",
		args: [arg("id", "入口编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		requiresConfirm: true,
		refresh: [
			"summary",
			"nearby",
			"story"
		]
	},
	{
		id: "explore.move",
		title: "移动",
		category: "explore",
		command: "移动",
		aliases: ["走"],
		usage: "/移动 <上|下|左|右>",
		args: [arg("direction", "方向", "enum", {
			required: true,
			options: [
				"上",
				"下",
				"左",
				"右"
			]
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: [
			"summary",
			"nearby",
			"battle"
		]
	},
	{
		id: "explore.travel",
		title: "前往地图",
		category: "explore",
		command: "前往",
		aliases: ["地图前往"],
		usage: "/前往 <地图代码>",
		args: [arg("mapCode", "地图代码", "text", { required: true })],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: [
			"summary",
			"nearby",
			"story"
		]
	},
	{
		id: "explore.move-to-target",
		title: "前往目标",
		category: "explore",
		command: "前往目标",
		usage: "/前往目标 <怪物编号>",
		args: [arg("id", "目标编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: [
			"summary",
			"nearby",
			"battle"
		]
	},
	{
		id: "explore.move-to-coordinate",
		title: "前往坐标",
		category: "explore",
		command: "前往坐标",
		usage: "/前往坐标 <x> <y> <z>",
		args: [
			arg("x", "X 坐标", "number", { required: true }),
			arg("y", "Y 坐标", "number", { required: true }),
			arg("z", "Z 坐标", "number", { required: true })
		],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: [
			"summary",
			"nearby",
			"battle"
		]
	},
	{
		id: "explore.map",
		title: "地图",
		category: "explore",
		command: "地图",
		usage: "/地图",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["summary", "nearby"]
	},
	{
		id: "system.status",
		title: "状态面板",
		category: "system",
		command: "状态",
		aliases: ["旅途", "面板"],
		usage: "/状态",
		args: [],
		readOnly: true,
		requiresCharacter: false,
		risk: "read",
		refresh: [
			"summary",
			"nearby",
			"battle",
			"party",
			"mail"
		]
	},
	{
		id: "explore.rest",
		title: "休息 / 起床",
		category: "explore",
		command: "休息",
		aliases: ["起床"],
		usage: "/休息 或 /起床",
		args: [],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: ["summary", "nearby"]
	},
	{
		id: "battle.action",
		title: "战斗操作",
		category: "battle",
		command: "战斗",
		aliases: ["攻击"],
		usage: "/战斗 [操作]",
		args: [arg("action", "操作", "rest")],
		readOnly: false,
		requiresCharacter: true,
		risk: "combat",
		refresh: [
			"summary",
			"battle",
			"inventory"
		]
	},
	{
		id: "story.register",
		title: "注册角色",
		category: "story",
		command: "注册",
		usage: "/注册",
		args: [],
		readOnly: false,
		requiresCharacter: false,
		risk: "write",
		requiresConfirm: true,
		refresh: ["summary", "story"]
	},
	{
		id: "story.ask",
		title: "询问引导",
		category: "story",
		command: "询问",
		usage: "/询问",
		args: [],
		readOnly: true,
		requiresCharacter: false,
		risk: "read",
		refresh: ["story"]
	},
	{
		id: "story.choose-destination",
		title: "选择去向",
		category: "story",
		command: "选择去向",
		usage: "/选择去向 <天堂|异世界>",
		args: [arg("destination", "去向", "enum", {
			required: true,
			options: ["天堂", "异世界"]
		})],
		readOnly: false,
		requiresCharacter: false,
		risk: "write",
		requiresConfirm: true,
		refresh: ["story", "summary"]
	},
	{
		id: "story.heaven",
		title: "踏入天堂",
		category: "story",
		command: "天堂",
		usage: "/天堂 继续",
		args: [arg("action", "操作", "enum", {
			required: true,
			options: ["继续"]
		})],
		readOnly: false,
		requiresCharacter: false,
		risk: "write",
		requiresConfirm: true,
		refresh: ["story", "summary"]
	},
	{
		id: "story.opening-choice",
		title: "初行选择",
		category: "story",
		command: "初行选择",
		usage: "/初行选择 <进度> <选项>",
		args: [arg("revision", "进度", "number", {
			required: true,
			min: 0
		}), arg("choice", "选项", "rest", { required: true })],
		readOnly: false,
		requiresCharacter: false,
		risk: "write",
		refresh: ["story", "summary"]
	},
	{
		id: "story.chapter",
		title: "初章选择",
		category: "story",
		command: "初章",
		usage: "/初章 包容之镇 <行动>",
		args: [arg("chapter", "章节", "enum", {
			required: true,
			options: ["包容之镇"]
		}), arg("action", "行动", "rest", { required: true })],
		readOnly: false,
		requiresCharacter: false,
		risk: "write",
		refresh: [
			"story",
			"summary",
			"nearby"
		]
	},
	{
		id: "story.continue",
		title: "继续剧情",
		category: "story",
		command: "继续剧情",
		usage: "/继续剧情",
		args: [],
		readOnly: false,
		requiresCharacter: false,
		risk: "write",
		refresh: [
			"story",
			"summary",
			"nearby"
		]
	},
	{
		id: "character.talent-catalog",
		title: "天赋目录",
		category: "character",
		command: "天赋目录",
		usage: "/天赋目录 [页码] [分组] [关键词]",
		args: [
			arg("page", "页码", "number", { min: 1 }),
			arg("group", "分组", "text"),
			arg("keyword", "关键词", "rest")
		],
		readOnly: true,
		requiresCharacter: false,
		risk: "read",
		refresh: ["story"]
	},
	{
		id: "character.talent-detail",
		title: "天赋详情",
		category: "character",
		command: "天赋详情",
		usage: "/天赋详情 <编码>",
		args: [arg("code", "天赋编码", "text", { required: true })],
		readOnly: true,
		requiresCharacter: false,
		risk: "read",
		refresh: ["story"]
	},
	{
		id: "story.opening-guild",
		title: "初行公会",
		category: "story",
		command: "初行公会",
		aliases: ["初行入会"],
		usage: "/初行公会 [区域]",
		args: [arg("area", "区域", "text")],
		readOnly: false,
		requiresCharacter: false,
		risk: "interaction",
		refresh: [
			"story",
			"summary",
			"party"
		]
	},
	{
		id: "character.equipment",
		title: "装备",
		category: "character",
		command: "装备",
		aliases: ["我的装备"],
		usage: "/装备",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["equipment", "inventory"]
	},
	{
		id: "character.equipment-detail",
		title: "装备详情",
		category: "character",
		command: "装备详情",
		aliases: ["已装备详情"],
		usage: "/装备详情 <编号>",
		args: [arg("id", "装备编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["equipment"]
	},
	{
		id: "character.equip",
		title: "穿戴装备",
		category: "character",
		command: "穿戴装备",
		usage: "/穿戴装备 <部位> <编号>",
		args: [arg("slot", "部位", "text", { required: true }), arg("id", "装备编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: [
			"summary",
			"equipment",
			"inventory"
		]
	},
	{
		id: "character.unequip",
		title: "卸下装备",
		category: "character",
		command: "卸下装备",
		usage: "/卸下装备 <部位>",
		args: [arg("slot", "部位", "text", { required: true })],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: [
			"summary",
			"equipment",
			"inventory"
		]
	},
	{
		id: "character.skills",
		title: "技能",
		category: "character",
		command: "技能",
		aliases: ["技能列表"],
		usage: "/技能 [已学习|可学习]",
		args: [arg("tab", "页签", "enum", { options: ["已学习", "可学习"] })],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["skills"]
	},
	{
		id: "character.skill-detail",
		title: "技能详情",
		category: "character",
		command: "技能详情",
		usage: "/技能详情 <编号>",
		args: [arg("id", "技能编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["skills"]
	},
	{
		id: "character.learn-skill",
		title: "学习技能",
		category: "character",
		command: "学习技能",
		usage: "/学习技能 <编号>",
		args: [arg("id", "技能编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: ["summary", "skills"]
	},
	{
		id: "character.upgrade-skill",
		title: "升级技能",
		category: "character",
		command: "升级技能",
		usage: "/升级技能 <编号>",
		args: [arg("id", "技能编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: ["summary", "skills"]
	},
	{
		id: "character.skill-shortcut",
		title: "技能快捷",
		category: "character",
		command: "技能快捷",
		usage: "/技能快捷 <编号>",
		args: [arg("id", "技能编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: ["skills"]
	},
	{
		id: "social.friends",
		title: "好友",
		category: "social",
		command: "好友",
		usage: "/好友",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["social"]
	},
	{
		id: "social.friend-requests",
		title: "好友申请",
		category: "social",
		command: "好友申请",
		usage: "/好友申请",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["social"]
	},
	{
		id: "social.add-friend",
		title: "添加好友",
		category: "social",
		command: "加好友",
		usage: "/加好友 <Game ID>",
		args: [arg("id", "Game ID", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		refresh: ["social"]
	},
	{
		id: "social.friend-profile",
		title: "好友资料",
		category: "social",
		command: "好友资料",
		usage: "/好友资料 <Game ID>",
		args: [arg("id", "Game ID", "number", {
			required: true,
			min: 1
		})],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["social"]
	},
	{
		id: "social.friend-interaction",
		title: "好友互动",
		category: "social",
		command: "玩家互动",
		usage: "/玩家互动 <Game ID>",
		args: [arg("id", "Game ID", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "interaction",
		refresh: ["social", "summary"]
	},
	{
		id: "social.oath",
		title: "星誓",
		category: "social",
		command: "星誓",
		usage: "/星誓",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["social"]
	},
	{
		id: "social.oath-requests",
		title: "星誓申请",
		category: "social",
		command: "星誓申请",
		usage: "/星誓申请",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["social"]
	},
	{
		id: "social.oath-request",
		title: "发起星誓",
		category: "social",
		command: "发起星誓",
		usage: "/发起星誓 <Game ID>",
		args: [arg("id", "Game ID", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: ["social", "summary"]
	},
	{
		id: "social.party",
		title: "队伍",
		category: "social",
		command: "队伍",
		aliases: ["队伍列表"],
		usage: "/队伍",
		args: [],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["party"]
	},
	{
		id: "social.leave-party",
		title: "退出队伍",
		category: "social",
		command: "退出队伍",
		usage: "/退出队伍",
		args: [],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: ["party", "summary"]
	},
	{
		id: "social.mail",
		title: "邮件",
		category: "social",
		command: "邮件",
		aliases: ["邮件页"],
		usage: "/邮件 [页码]",
		args: [arg("page", "页码", "number", { min: 1 })],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["mail"]
	},
	{
		id: "social.mail-detail",
		title: "查看邮件",
		category: "social",
		command: "查看邮件",
		usage: "/查看邮件 <编号>",
		args: [arg("id", "邮件编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: true,
		requiresCharacter: true,
		risk: "read",
		refresh: ["mail"]
	},
	{
		id: "social.mail-claim",
		title: "领取邮件",
		category: "social",
		command: "领取邮件",
		usage: "/领取邮件 <编号>",
		args: [arg("id", "邮件编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: [
			"mail",
			"inventory",
			"summary"
		]
	},
	{
		id: "social.mail-claim-all",
		title: "一键领取邮件",
		category: "social",
		command: "一键领取邮件",
		usage: "/一键领取邮件",
		args: [],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: [
			"mail",
			"inventory",
			"summary"
		]
	},
	{
		id: "inventory.use-item",
		title: "使用道具",
		category: "inventory",
		command: "使用道具",
		usage: "/使用道具 <编号>",
		args: [arg("id", "道具编号", "number", {
			required: true,
			min: 1
		})],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: [
			"inventory",
			"summary",
			"battle"
		]
	},
	{
		id: "character.choose-gift",
		title: "选择恩赐",
		category: "character",
		command: "选择恩赐",
		usage: "/选择恩赐 <编码>",
		args: [arg("code", "恩赐编码", "text", { required: true })],
		readOnly: false,
		requiresCharacter: true,
		risk: "write",
		requiresConfirm: true,
		refresh: [
			"summary",
			"character",
			"story"
		]
	}
];
const commandAliasMap = /* @__PURE__ */ new Map();
for (const entry of appCommandCatalog) {
	commandAliasMap.set(entry.command, entry);
	for (const alias of entry.aliases ?? []) commandAliasMap.set(alias, entry);
}
/** 只取命令的第一个词，兼容网页端传入的 `/命令 参数`。 */
const appCommandHead = (raw) => {
	return String(raw ?? "").trim().replace(/^\//, "").split(/\s+/).filter(Boolean)[0] ?? "";
};
const findAppCommand = (rawHead) => commandAliasMap.get(appCommandHead(rawHead));
const isAppCommandAllowed = (rawCommand) => Boolean(findAppCommand(rawCommand));
const appCommandCatalogFor = (hasCharacter) => appCommandCatalog.map((entry) => ({
	...entry,
	args: entry.args.map((argument) => ({
		...argument,
		...argument.options ? { options: [...argument.options] } : {}
	})),
	schema: { fields: entry.args.map((argument) => ({
		key: argument.name,
		label: argument.label,
		type: argument.type === "text" ? "string" : argument.type,
		...argument.required !== void 0 ? { required: argument.required } : {},
		...argument.min !== void 0 ? { min: argument.min } : {},
		...argument.max !== void 0 ? { max: argument.max } : {},
		...argument.options ? { options: argument.options.map((option) => ({
			label: option,
			value: option
		})) } : {}
	})) },
	enabled: !entry.requiresCharacter || hasCharacter,
	...entry.requiresCharacter && !hasCharacter ? { reason: "请先完成角色注册。" } : {}
}));
const findAppCommandById = (id) => {
	const value = String(id ?? "").trim();
	return appCommandCatalog.find((entry) => entry.id === value);
};
const appCommandCategories = [
	{
		id: "system",
		title: "系统"
	},
	{
		id: "story",
		title: "剧情"
	},
	{
		id: "explore",
		title: "探索"
	},
	{
		id: "battle",
		title: "战斗"
	},
	{
		id: "character",
		title: "角色"
	},
	{
		id: "inventory",
		title: "背包"
	},
	{
		id: "social",
		title: "社交"
	}
];

//#endregion
export { appCommandCatalog, appCommandCatalogFor, appCommandCategories, appCommandHead, findAppCommand, findAppCommandById, isAppCommandAllowed };