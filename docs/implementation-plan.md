# Harness House 实施计划

> 策略：分 Phase 实施，每个 Step 完成后汇报进度，全量测试覆盖

## Phase 1：MVP — Hermes 控制设备（点2 + 点1部分）

**目标**：用户通过微信说"开书房空调"，Hermes 直接控制 HA 执行

| Step | 内容 | 测试覆盖 |
|------|------|---------|
| 1.1 | 创建 `home-control` skill 骨架（SKILL.md + tool 注册） | skill 加载测试 |
| 1.2 | HA WebSocket 客户端：连接、认证、订阅 state_changed，维护内存状态缓存 | WebSocket 连接/重连/状态更新测试 |
| 1.3 | `control_device` tool：接收 entity_id + action，安全检查（读 Obsidian/配置），调 HA service，写审计日志 | 安全检查/执行/审计/错误处理测试 |
| 1.4 | `list_devices` tool：返回当前设备列表+状态（从内存缓存） | 设备列表查询测试 |
| 1.5 | `get_device_state` tool：查询单个设备状态 | 状态查询测试 |
| 1.6 | 集成测试：模拟"开书房空调"全链路 | 端到端测试 |

## Phase 2：Obsidian 知识库 + 数据迁移（点3 + 点4）

**目标**：Obsidian 存储设备知识/别名/安全策略，Hermes 读写

| Step | 内容 | 测试覆盖 |
|------|------|---------|
| 2.1 | Obsidian vault 结构搭建（rooms/devices/scenes/preferences/automations） | 结构验证测试 |
| 2.2 | 数据迁移脚本：从 HCM overlay JSON + spatial-editor JSON → Obsidian 笔记 | 迁移完整性测试 |
| 2.3 | Hermes 读取 Obsidian 设备笔记（别名解析、房间映射） | 读取/解析测试 |
| 2.4 | 安全策略 frontmatter 读写 + 二次确认逻辑 | 安全策略修改测试 |
| 2.5 | 集成测试：别名"大灯"→正确设备、安全 block→拒绝执行 | 端到端测试 |

## Phase 3：Web UI 独立 + 快捷控制（点5 + 点1 SSE）

**目标**：Web UI 独立运行，快捷按钮直连 HA，实时状态更新

| Step | 内容 | 测试覆盖 |
|------|------|---------|
| 3.1 | HA Token 代理（轻量 HTTP 代理，Token 不暴露给浏览器） | 代理安全测试 |
| 3.2 | SSE 端点：HA WebSocket → 前端 SSE 推送 | SSE 推送/重连测试 |
| 3.3 | Web UI 独立部署（静态服务 + 3D House + 设备列表） | UI 渲染测试 |
| 3.4 | 快捷控制按钮（toggle，直调代理，读安全策略） | 快捷控制+安全测试 |
| 3.5 | 集成测试：点按钮→设备开关→SSE 状态更新 | 端到端测试 |

## Phase 4：对话自动化 + 偏好学习（点6 + 点7）

**目标**：对话创建 HA 自动化，偏好持久化到 Obsidian

| Step | 内容 | 测试覆盖 |
|------|------|---------|
| 4.1 | `manage_automation` tool：HA automation CRUD（创建/修改/删除/查询） | CRUD 测试 |
| 4.2 | 对话→HA automation YAML 生成逻辑 | YAML 生成/验证测试 |
| 4.3 | 偏好学习：命令模式记录 + Obsidian 持久化 | 学习记录/持久化测试 |
| 4.4 | 偏好应用：LLM 上下文注入 Obsidian 偏好笔记 | 偏好应用测试 |
| 4.5 | 集成测试："每天23点关灯"→automation 创建 + 执行 | 端到端测试 |

## Phase 5：主动响应（点8）

**目标**：异常检测主动推送，偏好建议主动发起

| Step | 内容 | 测试覆盖 |
|------|------|---------|
| 5.1 | HA webhook → Hermes webhook 订阅（实时异常） | webhook 接收/触发测试 |
| 5.2 | Cronjob 异常检测脚本（查 HA 状态，检测异常条件） | 脚本检测逻辑测试 |
| 5.3 | Cronjob 偏好分析脚本（分析命令模式，生成建议） | 模式分析测试 |
| 5.4 | 集成测试：模拟异常→主动推送微信 | 端到端测试 |

## 测试策略

- 每个 Step 配套单元测试（pytest）
- 每个 Phase 结束配集成测试
- 测试可独立运行（不依赖真实 HA，用 mock）
- 测试覆盖：正常路径 + 错误处理 + 边界条件
- 后续修改不得破坏前面 Step 的测试（CI 回归）

## 进度汇报

每个 Step 完成后：
1. 代码提交（git commit）
2. 测试运行结果
3. 微信汇报进度
