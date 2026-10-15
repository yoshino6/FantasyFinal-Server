# H5 近程探索路线

以下接口挂载于现有 App/Web API 前缀下，均要求当前会话。QQ 方向移动、旧 `/explore/move` 与远途行程接口保持原有语义。

`GET /explore/local-map` 返回：

```ts
{
  ok: true,
  origin: { x: number, y: number, z: number, regionId: number },
  range: number, actionRange: number,
  movement: { step: number, maximum: number },
  cells: { x: number, y: number, z: number, regionId?: number, passable: boolean, reachable: boolean }[]
}
```

格子只包含当前角色的 Manhattan 感知菱形。区域通行采用真实 `map_region_areas` 覆盖优先级、开放/主人权限和航路许可；地下格采用感知范围内的实际迷宫通路。不可通行格不返回区域编号。目标图标仍来自既有 `panel.nearby.points`，不能从全区域地图地标补齐未感知目标。

`passable` 保留真实区域/墙体通路信息；`reachable` 表示从本次 `origin` 出发，使用四方向且总步数不超过 `min(movement.step, actionRange)` 能否抵达，当前起点为可达。服务端只对已感知格做一次 BFS 标记全部可达格，不读取或补齐感知范围外地图。绕路长度超出预算、被通路隔断或只由卡片额外感知到的格子，即使 `passable:true` 也会返回 `reachable:false`。前端只允许选择真实通行且可达的格子；预览仍会独立验证原有路径规则。

`POST /explore/route/preview` 接收 `{x,y,z}`，返回：

```ts
{
  ok: true, origin: {x,y,z,regionId},
  sightRange: number, actionRange: number, moveRange: number,
  path: {x:number,y:number,z:number,regionId?:number}[],
  stepMilliseconds: 260
}
```

四方向 BFS 返回最短路径，路径不含起点。目的地、整条路径以及总步数受点击时的移动步长与基础感知共同约束。卡片额外感知只提供观察，不放大可执行路线。规划直接读取已保存状态，不移动角色、不继续剧情，不创建默认移动设置或卡片状态，也不套用远途行程的持有地图要求。

`POST /explore/route/step` 接收 `{x,y,z,expectedFrom:{x,y,z,regionId}}`。每次仅允许相邻四方向一格，必须等待前一步响应后再发送下一步。事务第一条 SQL 锁定角色并校验当前坐标；重试、其他标签页或其他渠道已改变坐标时返回 409 `STALE_POSITION`。随后复用游戏原有落点、遭遇、剧情、组队与权限规则，返回原有 `CommandActionResult` 外加：

```ts
{ kind: string, text: string, position: {x,y,z,regionId}, moved: boolean,
  interactionTargets?: {type:string,id:string,name:string,description?:string}[], panel?: DesktopPanel }
```

成功提交一个普通步骤时 `moved:true`。开章/镇游剧情 middleware 拦截时返回 `moved:false` 和当前权威坐标，不能把请求目标当作已抵达。前端遇到 `moved:false`、任何 `kind !== 'event'`、剧情或战斗状态即停止后续步骤，按现有交互按钮处理事件。取消只停止后续请求，已经提交的步骤保留。不新增移动成本、体力扣除或服务端冷却；260 ms 是展示节奏。

错误继续使用 `{ok:false,message}`，本模块的校验额外给出 `code`：`INVALID_POSITION`、`WRONG_LAYER`、`OUT_OF_RANGE`、`BLOCKED_TARGET`、`NO_LOCAL_ROUTE`、`INVALID_STEP` 为 400，`STALE_POSITION` 为 409。现有业务拒绝仍使用原有 400 消息。

验证命令：`npx tsx --test test/local-exploration-route.test.ts test/mainline-web-handoffs.test.ts`。测试编译实际服务/路由函数并使用纯内存数据库适配器，覆盖通路、绕路/隔断可达性、初始步数与基础感知预算、权限覆盖、感知、事务锁、并发、途中遭遇、不可行动、剧情 handoff 和鉴权；不会导入真实数据库初始化模块或访问账号。

## 连续回放与远途展示轨迹

近程仍逐格串行请求 `/explore/route/step`，遇到任何实际目标立即停止。网页可以先收齐已经提交的连续路径，再以一个 RAF 在 1–2 秒内连续回放，按跨格边界切换对应面板；取消、离页或切换账号时必须以最后一个已经提交的响应为准。这里没有批量移动接口，也不将视觉中间坐标写回游戏。

既有远途 `travelStatus` 保留 `x/y/z`（目标）、`seconds/remaining`、活动/目的地字段，新增 `position:{x,y,z,regionId}`（实际当前坐标）及可选 `visual`。`panel.summary.travel.visual` 与 `/explore/travel`、未到期 `/explore/travel/settle` 的 `travel.visual` 使用相同契约：

```ts
type VisualPoint = { x:number, y:number, z:number, regionId:number, regionCode:string, regionName:string };
type TravelVisual = {
  id:string, serverNow:number, startAt:number, arrivalAt:number,
  start:VisualPoint, target:VisualPoint, totalDistance:number,
  segments:{
    kind:'walk'|'portal'|'guild', instant:boolean,
    from:VisualPoint, to:VisualPoint, distance:number, startAt:number, arrivalAt:number,
    waypoints:(VisualPoint & {distance:number,at:number})[]
  }[]
};
```

时间均为数据库同一时钟下的 Unix 毫秒值。`id` 使用 active 路线 token；`waypoints.distance` 为全行程累计路程，`at` 为对应节点的绝对时间。步行节点来自原压缩 Dijkstra 的前驱路径，保留真实拐点、区域边界和原最短距离。portal/guild 的原有计费路程与秒数保持原样，`instant:true` 表示展示应在该段 `arrivalAt` 跳到另一侧，不在不同楼层之间画直线步行。序列化不会暴露原计划中的队员账号或其他目标。

远途实际坐标仍在抵达结算时更新；途中仅有展示位置。现有取消规则仍使角色留在出发点。`/explore/travel`、cancel、settle 的 `position` 均为权威坐标，面板刷新失败时仍返回动作成功与该位置，不能把启动行程的目标当成已抵达。旧活动计划缺少保存的真实步行节点、起点不匹配或计划损坏时省略 `visual`，继续返回原有倒计时，不推测穿墙直线。寻怪不增加展示轨迹。

短距离命令“前往”沿用原本的一次落点和事件规则，事务提交并确认实际终点后才新增 `movementVisual`：

```ts
{ id:string, origin:VisualPoint, target:VisualPoint, totalDistance:number,
  waypoints:(VisualPoint & {distance:number})[] }
```

Core 执行上下文捕获该字段并透传到命令/签发动作响应，App 坐标/地图前往与 `/explore/travel` 即时分支也提供同样字段。捕获按每个异步命令隔离，回滚或落点不匹配不发布动画。该对象不带游戏计时，供网页按真实路程调整 1–2 秒回放速度；不改变原本短距离前往不逐格触发事件的规则。

联合验证：`npx tsx --test test/local-exploration-route.test.ts test/mainline-web-handoffs.test.ts test/travel-visual.test.ts test/movement-visual.test.ts`。仅使用纯逻辑和编译实际函数的内存适配器，涵盖绕障、区域过渡、换乘时间、旧计划兼容、命令隔离、提交/回滚、权威位置及面板失败回退，不访问真实数据库。
