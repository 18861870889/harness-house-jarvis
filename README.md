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
├── src/                          # Harness House 核心代码（不改动）
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
