# Harness House — Jarvis Edition

> Harness House 的贾维斯集成版。在原项目基础上加入 Hermes Agent 语音交互层，让你能用语音和家里的 AI 管家对话。

> ⚠️ 本仓库是 [harness-house](https://github.com/18861870889/harness-house) 的复刻版。原仓库用 Codex 继续完善核心能力，本仓库专注 Hermes 集成和语音交互体验。两边通过 HTTP API 解耦，互不影响。

## 这是什么

Harness House 是一个开源智能家居 AI 框架，提供统一的家庭能力模型（HCM）、AI 意图理解、安全执行和持续学习。

本仓库在原项目基础上，增加了 `hermes-integration/` 目录，集成 Hermes Agent 作为语音对话代理层。这样 Harness House 专注做**设备安全执行**，Hermes 专注做**对话/记忆/人格/编排**，两者通过 API 协作。

## 架构

```
你说话 → Mac Mini 麦克风
  → Hermes STT (faster-whisper, 本地)         ~250ms
  → 云端 LLM 流式 (GLM, 首 token)              ~500ms
  │   ├── 闲聊/知识/情感 → 流式回复
  │   └── 设备控制 → harness_command tool
  │                  → Harness House /api/hcm/command
  │                  → Safety Gate → Policy Gate → Execute  ~200ms
  → Hermes TTS (edge-tts, 流式)                ~200ms
  → Mac Mini 音箱

首字延迟: ~950ms ~ 1,350ms
```

## 快速开始

### 可行走的家庭沙盒 Alpha

独立的 **Blender 资产 + Three.js 实时场景 + Rapier 碰撞 + Pi/D1** 沙盒已支持复用原项目的户型编辑数据、HA 设备目录、多键开关与逻辑灯具映射。**HA 只读接入；控制指令仍只改变独立模拟副本，不改原户型，不调用云端 LLM。**

```bash
npm ci
# 接入既有家庭：按模板配置原项目目录（本地文件不入库）
cp data/sandbox-source.example.json data/sandbox-source.local.json
npm run demo:sandbox
# 在 Chrome 打开 http://localhost:5184/
# 可选后台启动：npm run demo:sandbox -- --background
```

读取原目录的 `home_model_cache.json`、`data/spatial-editor.local.json` 和 `data/home-model-overlay.local.json`；HA 地址/令牌只从服务端环境或原目录 `.env` 的 HA 字段读取。配置缺失时保留两房间样板；已配置家庭读取失败则报错，不偷偷换成样板。当前本机保存目录对应 12 个区域、45 台物理设备、43 个逻辑受控对象和 61 个场景设备点，私人户型与目录不会提交到仓库。

点击地面、W/A/S/D、方向键或屏幕方向按钮移动人物；房间归属来自人物位置，不是摄像机视角或设备面板所选房间。可在“房间设备”选择书房，再点击脚印走过去，输入“打开书房射灯”。设备详情可对照 HA 参考快照、模拟状态和实际控制回路。传感器只读，不随人物移动伪造真实状态。

HA 每 30 秒只读刷新目录和参考状态，失败时保留最后快照并标记时间/错误；新版快照需显式载入，不覆盖进行中的模拟。“场景轨迹”可导出 JSON 或隔离回放，绑定录制时的家庭基线。语音输入使用 Chrome STT，可能联网，TTS 默认关闭；这不是完全离线语音方案。

模型默认使用局域网 `http://192.168.1.154:8080/v1/systemone`，可通过 `D1_ENDPOINT` 修改；无需模型 key 或 Hermes。Node.js 24+，浏览器须支持 WebGL。预生成 GLB 已入库，普通运行不需要 Blender；重建资产用 `npm run assets:sandbox`。家具是风格化通用资产，门洞和米制尺寸为推断，不是实测装修图。

运行 `npm run test:sandbox:ha` 自动启动隔离的合成 HA 家庭并测试本地 D1、Chrome 桌面/手机画布、行走、回放和只读边界；设置 `HARNESS_SANDBOX_SOURCE_DIRECTORY` 可测试自己的已保存家庭，仍不会控制真实设备。旧样板的 `test:sandbox:ui` 另含语音事件回归，需显式样板服务。说明和验证结果见 [家庭沙盒 Alpha](docs/HOME_SANDBOX_ALPHA.md)。入口 5184，原主页与 `demo:d1` 保持独立。

沙盒默认使用 **D1 语义契约 v3**：先判断本轮意图、数量、反馈和目标表述，再根据真实 HCM 名称、房间与能力编译动作，不再把整组开灯/关灯方案混在一起选择。修复了换房间串用旧目标、一个灯变成多个、射灯包含吊灯、新要求拼接旧问题等情况；“只留一盏”是最终状态约束，否定和查询不能变成设备动作。不是强化学习，默认灯仍采用稳定的主灯优先策略。

`npm run test:d1:sandbox:live` 配合 `HARNESS_SANDBOX_SOURCE_DIRECTORY` 可复现本地 D1 的 53 组原家庭模拟回归，不读取 `.env`，不连接 HA、不执行真实设备。完整结果与限制见 [D1 语义契约 v3](docs/D1_SEMANTIC_CONTRACT_V3.md)。`SANDBOX_DECISION_VERSION=v2` 可运行历史比较；契约版本不代表主应用发布版本。本次另开的 5185 演示保留原 5184 测试状态。

### D1 本地决策实验

本分支提供独立的 D1-only 实验：不调用 DeepSeek/OpenAI，不需要 API key，也不需要真实 HA。
`npm ci && npm run demo:d1` 启动后，在 `http://localhost:5173/` 选择“模拟执行”。所有设备状态只保存在内存中，重启会恢复；这不是你的真实家庭设备目录。

可测试“打开书房射灯”“关闭餐厅吊灯”“书房空调调到24度”“客厅电视怎么打开”。详细架构、验证结果和已知限制见 [D1 实验说明](docs/D1_LOCAL_DECISION_EXPERIMENT.md)。这是实验入口，尚不替代现有完整 Hermes 对话方案。

### D1 Harness 框架对比

独立实验分支比较 Pi Agent Core 与 LangGraph JS 的会话持久化、澄清恢复、取消和执行去重。运行 `npm run test:harness` 或 `npm run compare:harness`；加 `-- --live` 仅调用本地 D1，设备仍全部模拟，不连接真实 HA。
Pi 适配已完成一轮稳定性加固：执行结果与会话事务保存、重启恢复、取消竞争、重复请求去重和会话资源限制均有模拟测试。Pi 现在可作为下一阶段原型候选，但尚未迁移主页面，也未接入真实设备。
运行 `npm run soak:pi` 可复现一分钟、2,000 条模拟请求压力测试；完整结果与上线前边界见 [Pi 加固报告](docs/PI_HARNESS_HARDENING.md)。最初对比与历史意图门控问题见 [框架对比说明](docs/D1_HARNESS_COMPARISON.md)。

### D1 意图与上下文 v2

实验运行时已加入完整决策单次选择、上下文/可信终端房间定位、照明目标调整和明确用户反馈。低置信度方案会先问“要我补开书房吊灯吗？”，确认后重新决策与校验，不直接执行。不是强化学习，也没有降低安全阈值。

此前 v2 阶段测试基线为 413 项通过、3 项在线测试跳过；最新沙盒回归见 [沙盒测试记录](docs/HOME_SANDBOX_ALPHA.md#资产与验证)。真实局域网 D1、模拟设备回归：严格用例 34/36，额外表达 18/18；两条仍需澄清，尚未全部通过。运行 `npm run test:d1:intent:live` 复测；严格回归未全通过时返回退出码 1。详见 [v2 实现与边界](docs/D1_INTENT_CONTEXT_V2.md)。**尚未切换主网页或 `demo:d1`，也没有控制真实 HA 设备。**

### 前提条件

- Mac Mini 上已安装 Hermes Agent
- Home Assistant 已运行，HA_BASE_URL 和 HA_TOKEN 可用
- LLM API key 已配置（DeepSeek 或 OpenAI 兼容）

### 1. 启动 Harness House

```bash
cd harness-house-jarvis
cp .env.example .env
# 编辑 .env: HA_BASE_URL, HA_TOKEN, OPENAI_API_KEY
# 可选: export HARNESS_EXECUTION_MODE=real (开启真实设备控制)
npm install
npm run dev
```

### 2. 配置 Hermes 集成

```bash
cd hermes-integration
bash config/setup.sh
```

### 3. 开始对话

```bash
hermes
/voice on

# 说话试试：
# "你好"
# "关客厅灯"
# "客厅灯开了吗"
# "太亮了"
# "今天几号"
```

## 目录结构

```
harness-house-jarvis/
├── src/                          # Harness House 核心与独立实验
│   └── sandbox/                  # 独立可行走家庭沙盒
├── public/sandbox/               # Blender 导出的 GLB / 原创纹理
├── scripts/                      # 模拟服务、资产构建与测试
├── docs/                         # Harness House 文档
├── server.mjs                    # Harness House API 服务
├── hermes-integration/           # ← 新增：Hermes 集成层
│   ├── tools/
│   │   └── harness_command.py    # Hermes tool: 调 Harness House API
│   ├── config/
│   │   ├── AGENT_PERSONA.md      # 贾维斯人格定义
│   │   ├── setup.sh              # 一键安装脚本
│   │   └── hermes-config.yaml    # Hermes 配置参考
│   └── docs/
│       └── architecture.md       # 集成架构详解
└── README.md
```

## 延迟预期

| 场景 | 首字延迟 | 体感 |
|---|---|---|
| 纯闲聊（"你好"） | ~950ms | ✅ 自然 |
| 明确设备控制（"关客厅灯"） | ~1,350ms | ✅ 可接受 |
| 模糊意图（"太亮了"） | ~2,150ms | ⚠️ 有点慢但能用 |
| 状态查询（"灯开了吗"） | ~1,350ms | ✅ 可接受 |

## 与原仓库的关系

| | 原仓库 (harness-house) | 本仓库 (harness-house-jarvis) |
|---|---|---|
| 定位 | 核心能力完善 | Hermes 语音集成 |
| 维护工具 | Codex | Hermes Agent |
| 改动范围 | src/, docs/, server.mjs | hermes-integration/ |
| 通信方式 | — | HTTP API (localhost:5173) |
| 同步策略 | 主仓库 | 定期从上游 merge 核心代码 |

## 后续升级路径

| 升级 | 效果 | 成本 |
|---|---|---|
| skip_planner 模式 | 设备控制少调一次 LLM | server.mjs 小改 |
| 本地 Qwen 7B MLX | 首字延迟降到 ~450ms | 纯软件 |
| USB 麦克风阵列 | 客厅全区域收音 | ~200元 |
| openWakeWord 唤醒词 | 免 push-to-talk | 纯软件 |
| 多房间终端 | 每房间一个语音入口 | 旧手机/平板 |

## License

MIT
