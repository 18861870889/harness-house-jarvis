# Architecture: Jarvis Voice Integration

## 概述

本目录包含 Harness House + Hermes 集成的所有文件。Harness House 核心代码不做改动，只在 `hermes-integration/` 目录下添加 Hermes 侧的集成层。

## 分层架构

```
┌─────────────────────────────────────────────────────────┐
│                    用户交互层                             │
│                                                         │
│  语音（在家）          文本（远程）         后台（异步）    │
│  麦克风 → Hermes      微信 → Hermes       cronjob       │
│  /voice on            gateway              定时检查       │
└──────────────┬──────────────┬──────────────┬────────────┘
               │              │              │
               ▼              ▼              ▼
┌─────────────────────────────────────────────────────────┐
│                  Hermes Agent 层                         │
│                                                         │
│  STT (faster-whisper)  →  LLM (GLM 流式)  →  TTS (edge)  │
│                                                         │
│  Memory (长期记忆 + 人格)                                │
│  Skills (复用流程)                                      │
│  delegate_task (跨域编排)                                │
│  cronjob (主动触发)                                     │
│                                                         │
│  Tool: harness_command ──→ HTTP POST                    │
│  Tool: web_search ──────→ 外部知识                       │
└──────────────────────────┬──────────────────────────────┘
                           │
                           │ HTTP /api/hcm/command
                           ▼
┌─────────────────────────────────────────────────────────┐
│              Harness House 安全执行层                     │
│              （本仓库核心代码，不改动）                     │
│                                                         │
│  /api/hcm/command                                       │
│    → Context Snapshot                                   │
│    → HCM Overlay + Personal Semantics                   │
│    → Prompt Context Pack v2                             │
│    → LLM Planner (DeepSeek V4)  ← 后续可加 skip_planner  │
│    → Intent Frame Normalize                             │
│    → Semantic Grounding Resolver                        │
│    → Intent Accuracy Engine                             │
│    → Safety Gate                                        │
│    → Policy Gate                                        │
│    → Provider Adapter Simulate                          │
│    → Decision Review                                    │
│    → Authorized Execute                                 │
│    → Provider State Readback                            │
│    → Audit + Learning                                   │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              Home Assistant → 物理设备                    │
└─────────────────────────────────────────────────────────┘
```

## 延迟分析

### 语音闲聊（"你好"）
```
STT (faster-whisper, 本地)     ~250ms
LLM 首 token (云端流式 GLM)     ~500ms
TTS 首音节 (edge-tts)           ~200ms
─────────────────────────────────────
首字延迟:                       ~950ms  ✅
```

### 设备控制（"关客厅灯"）
```
STT                            ~250ms
LLM 首 token + tool call       ~700ms
Harness House 执行              ~200ms
TTS                            ~200ms
─────────────────────────────────────
总延迟:                        ~1,350ms  ✅
```

### 模糊意图（"太亮了"）
```
STT                            ~250ms
LLM 意图理解                   ~1,500ms
Harness House 执行              ~200ms
TTS                            ~200ms
─────────────────────────────────────
总延迟:                        ~2,150ms  ⚠️
```

## 文件说明

| 文件 | 用途 |
|---|---|
| `tools/harness_command.py` | Hermes tool，调 Harness House API |
| `config/AGENT_PERSONA.md` | 贾维斯人格定义 |
| `config/setup.sh` | 一键安装脚本 |
| `config/hermes-config.yaml` | Hermes 配置参考 |

## 后续优化

### skip_planner 模式（减少一次 LLM 调用）

当前设备控制会调两次 LLM：
1. Hermes 调 GLM 理解意图
2. Harness House 调 DeepSeek V4 编译计划

可以加 `skip_planner` 参数：Hermes 传 Intent Frame，Harness House 跳过自己的 LLM Planner。

需要改 Harness House 的 `server.mjs`：
```javascript
const draft = payload.intent_frame && payload.skip_planner
  ? payload.intent_frame
  : plannerDevices.length === 0
    ? buildNoPlannerDevicesDraft(payload.input, home)
    : callHcmPlannerModel({...});
```

### 本地 LLM（降低延迟）

用 Qwen2.5-7B MLX 在 Mac Mini 上跑：
- 简单闲聊走本地 LLM（首 token ~200ms）
- 复杂对话降级云端 LLM
- 设备控制走 fast path（不调 LLM）

### Wake Word（免 push-to-talk）

用 openWakeWord 做"贾维斯"唤醒词检测，实现 always-listening。
