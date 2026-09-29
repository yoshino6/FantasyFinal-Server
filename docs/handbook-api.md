# H5 冒险手册接口契约

仅注册于 `/api/web/v1`。所有接口使用 Bearer 登录会话；成功返回 `{ "ok": true, "data": ... }`，业务失败返回 `{ "ok": false, "message": "..." }`。列表的 `page` 从 1 开始，超过末页时返回末页。

## 足迹（成就）

| 方法与路径 | 输入 | `data` |
| --- | --- | --- |
| `GET /handbook/achievements` | `category`（默认`全部`）、`page` | Core 已达成列表：`category,categories,page,totalPages,total,entries,scope:'completed_only'`。每条为 Core 的 `id,name,category,description,rarity,attribute,rank,percentage,completedAt`，另有 `status:'completed',actions:[]`。 |
| `GET /handbook/achievements/:id` | Core 成就编号 | 本人已达成详情，同上单条结构。未达成与不存在返回同一错误。 |
| `GET /handbook/achievements/rewards` | 无 | `boxes`（`odd_box,rare_box,collector_box` 数量）、`items`、库存大于 0 时的 `actions:[{id:'open_box',boxKey,name,available}]`。 |
| `POST /handbook/achievements/rewards/:boxKey/open` | JSON `{requestId,quantity}`；`requestId` 为客户端生成的 UUID v4，`quantity` 默认 1、最大 100 | Core `openAchievementBox` 的幂等开启结果。完成后单独重取奖励与背包。 |

成就在 Core 业务事务内达成并结算，暂无逐条领取动作；未达成条件和部分进度不会通过 H5 泄露或伪造。

## 图鉴

| 方法与路径 | 输入 | `data` |
| --- | --- | --- |
| `GET /handbook/codex` | `kind`（默认`装备`，可为`装备/道具/材料/怪物/技能`）、`category`（默认`全部`）、`keyword`、`page` | Core 已发现列表，含 `kinds,categories,kind,category,keyword,entries,page,totalPages,pageSize:5,scope:'discovered_only'`。条目里的 `detailId` 用于详情。 |
| `GET /handbook/codex/:kind/:id` | `:id` 为列表的 `detailId` | `{kind,detailId,detail,actions:[]}`。怪物资料沿用 Core 鉴识等级限制；技能仅限已领悟或已发现；物品沿用已发现或商店公开权限。 |

物品详情返回基础字段 `id,code,codexId,name,category,type,requiredLevel,description,obtainSource,weight`；技能返回基础战斗字段与效果文本。装备实例属性仍使用装备详情接口，图鉴基础字段不代表实例词条。

## 通缉

| 方法与路径 | 输入 | `data` |
| --- | --- | --- |
| `GET /handbook/warrants` | `filter`（`全部/已暴露/近期露面/无行踪`，默认`全部`）、`page` | 百纳镇本地生效令：`regionName,filter,page,pageSize:10,total,totalPages,entries`。每条含赏金、星级、行踪状态；无行踪时 `position:null`。 |
| `GET /handbook/warrants/:id` | 通缉令编号 | 当地生效令详情；只有持有该目标未返还失物的玩家收到 `actions:[{id:'add_reward',requiresPreview:true}]`。 |
| `GET /handbook/warrants/posts` | `page` | 本人历史上赏记录，每页 10 条；含通缉状态、目标、上赏内容和领取者。 |
| `GET /handbook/warrants/pursuits` | `page` | 本人真实缉捕或赏金领取记录，每页 10 条；`recordType` 为 `capture` 或 `reward_claim`。不把普通 PvP 伪作追缉。 |
| `GET /handbook/warrants/reward-items` | `page` | 本人可上赏的可交易未绑定堆叠物品，每页 20 条，含 `itemId,name,codexId,available`。 |
| `POST /handbook/warrants/:id/reward-preview` | JSON `{kind:'copper',amount}` 或 `{kind:'item',itemId,quantity}` | 当前资格及库存的只读预览，含 `canSubmit,reason,available` 与消耗字段；不预留资源。 |
| `POST /handbook/warrants/:id/rewards` | 同预览请求体 | 调用 Core `addWarrantReward`，在事务内重新校验通缉状态、失物关系和余额；物品仅扣未绑定库存。 |

榜单沿用 Core `townWarrantsFor`，必须在百纳镇内查看；不会提供 Core 未给出的等级、头像或过期时间。上赏预览不替代提交时的校验。H5 暂无新建通缉令、攻击或自动追踪动作。
