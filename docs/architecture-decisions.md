# Harness House 架构决策记录

> 更新时间：2026-06-28
> 状态：逐条讨论中，所有方案确认后再统一写代码

## 通路设计（已确认）

```
多端入口（微信/语音模块/其他端侧）
      │
      ▼
   Hermes（GLM-5.2，理解意图 + 拿设备列表 + 映射 device_id + 生成 plannerDraft）
      │
      ▼ POST /api/hcm/command {skipPlanner: true, plannerDraft: {...}}
   HCM（安全门禁 → 策略门禁 → 模拟校验 → 决策复核 → 审计记录）
      │
      ▼ HA service call
   执行
```

### 职责分工（已确认）

| 层 | 职责 | 不做什么 |
|---|---|---|
| Hermes | 理解人话、设备映射、生成 plannerDraft | 不直接调 HA |
| HCM | 安全/策略/审计/执行 | 不做设备解析（设备解析由 Hermes 完成） |

- HCM 设备解析器仅在 Hermes 不可用时作为 Web UI fallback
- Hermes 获取设备列表：调 `/api/hcm/home`（305ms，可缓存）或通过 SSE 推送变更

## 8 项核心能力评估

### 点1：实时监测 → Plan C（已确认）

**现状**：无自动刷新，手动点"同步"才更新。setInterval(tickDevices) 是模拟器动画帧，不是 HA 状态拉取。

**C 方案实现**：

服务端（server.mjs）：
1. HA WebSocket 客户端：连接 `ws://HA_BASE_URL/api/websocket`，认证后订阅 `state_changed`
   - 更新内存中 HCM home 模型的设备状态
   - 通过 SSE 推给前端
2. SSE 端点 `GET /api/hcm/events`：
   - 连接时推全量状态快照（解决 0/3→0/9 闪烁）
   - 之后推增量 `state_patch` 事件
   - 30s 心跳
3. 60s 定时 `discoverHcmHome()` 检测新设备/改名/结构变更 → 推 `model_refresh`

前端（App.jsx）：
4. EventSource 监听 `/api/hcm/events`
   - `snapshot` → 初始化设备状态
   - `state_patch` → 增量更新（不触发完整 re-render）
   - `model_refresh` → 调 `refreshHcmHome()`
5. 编辑保护：地图编辑器操作中暂停 `model_refresh`
6. `refreshHcmHome` 改为只更新设备状态属性，不重建 scene（3D 相机不重置）

### 点2：Hermes 大脑 ✅ 已确认

**决策**：All in Hermes，砍掉 HCM 的 LLM 规划层。不做快速匹配层（暂不需要）。

**架构**：
```
用户输入 → Hermes LLM（GLM-5.2）→ control_device tool（安全+执行+审计）→ HA
```
- LLM 负责理解意图 + 设备映射 + 生成结构化参数
- tool 负责安全策略检查（确定性代码）+ HA service call + 审计日志
- 每次命令一次 LLM 调用，无快速匹配
- Web UI 快捷按钮未来可直连 HA，不走 Hermes

**现状（待改造）**：
- UI 写死 "Hermes · glm-5.2"（App.jsx:1157/1286/3213），但后端直连 DeepSeek API
- .env: `OPENAI_BASE_URL=https://api.deepseek.com`, `OPENAI_MODEL=deepseek-v4-flash`
- 代码已预留 `skipPlanner + plannerDraft` 通道（server.mjs:891-895），但无人调用
- HCM 的 LLM 规划层（callHcmPlannerModel）将被 Hermes 替代

**实测耗时（8条命令）**：
| 阶段 | 耗时 | 占比 |
|---|---|---|
| context_snapshot | 305ms | 9% |
| **llm_planner** | **3233ms** | **91%** |
| 其他14个阶段 | <20ms | <1% |

**需增强的专业性**（skill: home-control）：
1. 设备知识库（HA 设备缓存 + WebSocket 实时更新）
2. 安全策略引擎（tool 级确定性检查，LLM 无法绕过）
3. 别名与空间知识（设备别名表、房间布局、位置感知）
4. 场景存储（命名场景，零 LLM 调用重复执行）
5. 自动化能力（事件触发 + cron + HA automation YAML 生成）
6. 审计日志（结构化 JSONL）

### 点3：地图 + 别名 ✅ 已确认

**决策**：Obsidian 作为家庭知识中枢，存储所有静态知识；实时状态放 Hermes 内存缓存。

**Obsidian Vault 结构**：
```
~/Documents/Obsidian-Vault/home-control/
  /rooms/        # 房间名、矩形坐标、合并关系、设备链接
  /devices/      # entity_id、别名、房间link、类型、安全级别
  /scenes/       # 命名场景（睡眠/观影/离家）
  /preferences/  # 用户偏好（灯光/温度）
  /automations/  # 自动化规则
  /spatial-layout.json  # 地图坐标数据（矩形/设备放置点）
```

**数据分层**：
| 数据 | 位置 | 理由 |
|---|---|---|
| 设备别名/房间布局/场景/偏好/自动化 | Obsidian | 低频变更、人可读、形成知识网络 |
| 地图坐标 | Obsidian vault 内 JSON | Web UI 读写 |
| 设备实时状态（开/关/温度） | Hermes 内存缓存 | 高频变更，WebSocket 从 HA 推送，不写 Obsidian |
| 安全策略 | Obsidian 或独立文件 | 需被 tool 确定性读取 |

**地图编辑器**：独立前端，直读 HA 状态 + 读写 Obsidian vault 文件，不依赖 HCM 后端。

**知识网络**：Obsidian graph view 可视化 设备↔房间↔场景↔偏好 关系。Hermes 沿链接遍历获取完整上下文。

### 点4：安全控制 ✅ 已确认

**决策**：安全策略存 Obsidian 设备笔记 YAML frontmatter，修改需二次确认。

**存储**：每个设备笔记的 frontmatter 包含 `safety: allow_auto / block / need_confirm`

**修改入口**：
- 对话修改："把冰箱设为禁止自动控制" → Hermes 修改笔记 safety 字段 → 需二次确认
- Web UI：设备详情页安全级别切换 → 需二次确认

**执行检查**：`control_device` tool 执行前读 Obsidian safety 字段，`block` 直接拒绝，LLM 无法绕过。

### 点5：快捷控制 ✅ 已确认

**决策**：Web UI 快捷按钮直连 HA，不走 Hermes/LLM，<100ms 响应。安全检查仍读 Obsidian。

**路径**：快捷按钮点击 → 读 Obsidian safety 字段 → 直调 HA REST API → SSE 推状态更新到按钮
**安全**：block 的设备按钮禁用或弹确认；allow_auto 的直接执行

### 点6：对话自动化 ✅ 已确认

**决策**：Hermes 理解自然语言 → 生成 HA automation → 推送 HA 执行。Hermes 与 HA 联动，支持自动化 CRUD。

**两类自动化**：
- 时间触发型（"每天23点关所有灯"）→ Hermes 生成 HA automation YAML → HA API 创建 → HA 执行
- 事件触发型（"人离开客厅5分钟后关灯"）→ 同上，HA 监听传感器事件并执行

**Hermes 能力**：
- 新增："每天23点关所有灯" → 生成 automation → HA API 创建 → 存 Obsidian /automations/
- 修改："把刚才的定时改成22点半" → 更新 HA automation → 更新 Obsidian
- 删除："取消自动关灯" → 删除 HA automation → 更新 Obsidian
- 查询："我现在有哪些自动化" → 读 HA automation 列表 + Obsidian 记录
- 复杂逻辑补充（"明天超过35度提前开空调"）→ Hermes cronjob 处理

**数据流**：对话 → Hermes LLM 理解 → HA API CRUD → Obsidian 记录（可审计）

### 点7：偏好学习 ✅ 已确认

**决策**：偏好存 Obsidian `/home-control/preferences/`，Hermes 穷尽知识和上下文后才询问用户。

**偏好存储**：Obsidian 按主题存笔记（灯光偏好/温度偏好/作息偏好等）

**学习方式**：
- 被动学习：Hermes 记录命令模式，发现规律后存入 Obsidian 偏好笔记
- 主动反馈：用户直接说"我习惯先开射灯"→ Hermes 存为偏好
- 修正学习：用户纠正"不对，那个灯是射灯"→ Hermes 更新偏好

**询问原则**（核心）：
1. 先用当前上下文（对话历史）+ Obsidian 知识（偏好/房间/别名）尝试决策
2. 能判断 → 直接执行 + 简短人性化反馈（"书房射灯已打开"）
3. 仍无法判断 → 才询问用户（"你在哪个房间？" / "射灯还是吊灯？"）

**例子**：
- "开灯" + 不知用户位置 → 问"你在哪个房间？"
- "开灯" + 知道在书房 + 书房2盏灯 + 无偏好 → 问"射灯还是吊灯？"
- "开灯" + 知道在书房 + 偏好"优先射灯" → 直接开射灯 + "书房射灯已打开"

**持续上下文**：偏好在 Obsidian，跨会话不丢失，每次新对话 Hermes 可读。

### 点8：语音 I/O + 主动响应 ✅ 已确认

**决策**：语音通过 Hermes 已有能力（STT/TTS/微信语音）。主动响应用 HA webhook → Hermes webhook（实时）+ cronjob + 脚本（定时）两层实现。

**语音输入输出**：
- 微信场景：用户发语音 → 微信转文字 → Hermes 处理 → 回复
- 端侧语音模块：STT → 文本发 Hermes → 回复 → TTS 播报
- Web UI：浏览器 Web Speech API（已有）

**主动响应两层体系**：
- **Tier 1 实时**：HA webhook → Hermes webhook 订阅（`hermes webhook subscribe ha_alerts`）→ agent 运行 → 推送微信。<1s 延迟。适合紧急异常。
- **Tier 2 定时**：Hermes cronjob 每5min + Python 脚本查 HA API → 有异常才让 LLM 生成消息。适合非紧急异常。
- **Tier 3 每日**：cronjob 每日 + 脚本分析命令模式 → 偏好建议。1次/天。

**成本控制**：脚本做检测（确定性，无 LLM token），仅在有事时才让 LLM 生成消息。无异常时 LLM 快速判断"无事可报"。

**差异化**：主流智能家居（Google Home/Alexa/HA Conversation Agent）全为被动响应。AI 驱动的主动响应是差异化卖点。

**注意**：不使用 Hermes 内置 `homeassistant` toolset（文档警告其绕过外部安全层），用自定义 `control_device` tool。

## 已完成的 Bug 修复

1. 3D 聚合房间内部墙：wall-wall 重叠检测替代中点检测（commit a351254）
2. overlay entityId 修正：1110295954（阳台开关）→ 1110310854（主卧入户开关）
3. placeSpatialDevice：不在房间矩形内时不覆盖房间归属（commit 150890e）
4. 主卧左/右射灯 deviceAssignments 恢复 null→master
