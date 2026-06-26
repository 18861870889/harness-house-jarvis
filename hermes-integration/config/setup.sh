#!/bin/bash
# Jarvis Voice Setup Script
# 一键配置 Hermes + Harness House 语音集成

set -e

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HARNESS_URL="${HARNESS_HOUSE_URL:-http://localhost:5173}"

echo "🤖 Jarvis Voice Setup"
echo "================"
echo "Hermes Home:    $HERMES_HOME"
echo "Project Dir:    $PROJECT_DIR"
echo "Harness House:  $HARNESS_URL"
echo ""

# 1. 检查 Hermes 是否安装
if ! command -v hermes &> /dev/null; then
    echo "❌ Hermes Agent 未安装。请先安装："
    echo "   curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
    exit 1
fi
echo "✅ Hermes 已安装: $(hermes --version 2>&1 || echo 'version unknown')"

# 2. 检查 Harness House 是否在运行
echo ""
echo "检查 Harness House..."
if curl -s "$HARNESS_URL/api/runtime/status" | grep -q "ok" 2>/dev/null; then
    echo "✅ Harness House 运行中"
else
    echo "⚠️  Harness House 未运行或不可达"
    echo "   请先启动: cd $PROJECT_DIR && npm run dev"
    echo "   确认 HA_BASE_URL, HA_TOKEN, OPENAI_API_KEY 已配置"
    echo ""
    read -p "是否继续安装配置文件？（y/N）" -r
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

# 3. 安装 faster-whisper（本地 STT）
echo ""
echo "安装本地 STT (faster-whisper)..."
if pip show faster-whisper &> /dev/null 2>&1; then
    echo "✅ faster-whisper 已安装"
else
    pip install faster-whisper 2>&1 | tail -3
    echo "✅ faster-whisper 安装完成"
fi

# 4. 配置 Hermes STT
echo ""
echo "配置 Hermes STT..."
hermes config set stt.enabled true 2>/dev/null || echo "   (需手动配置)"
hermes config set stt.provider local 2>/dev/null || echo "   (需手动配置)"
hermes config set stt.local.model base 2>/dev/null || echo "   (需手动配置)"
echo "✅ STT 配置为本地 faster-whisper (base)"

# 5. 配置 Hermes TTS
echo ""
echo "配置 Hermes TTS..."
hermes config set tts.provider edge 2>/dev/null || echo "   (需手动配置)"
echo "✅ TTS 配置为 edge-tts (免费)"

# 6. 安装 harness_command tool
echo ""
echo "安装 harness_command tool..."
TOOL_DIR="$HERMES_HOME/tools"
mkdir -p "$TOOL_DIR"
cp "$SCRIPT_DIR/tools/harness_command.py" "$TOOL_DIR/harness_command.py"
echo "✅ harness_command tool 已安装到 $TOOL_DIR/"

# 7. 安装人格文件
echo ""
echo "安装贾维斯人格文件..."
cp "$SCRIPT_DIR/config/AGENT_PERSONA.md" "$HERMES_HOME/AGENT_PERSONA.md"
echo "✅ 人格文件已安装到 $HERMES_HOME/AGENT_PERSONA.md"

# 8. 配置环境变量
echo ""
echo "配置环境变量..."
ENV_FILE="$HERMES_HOME/.env"
if ! grep -q "HARNESS_HOUSE_URL" "$ENV_FILE" 2>/dev/null; then
    echo "HARNESS_HOUSE_URL=$HARNESS_URL" >> "$ENV_FILE"
    echo "✅ HARNESS_HOUSE_URL 已写入 $ENV_FILE"
else
    echo "✅ HARNESS_HOUSE_URL 已存在"
fi

# 9. 完成
echo ""
echo "================"
echo "✅ 安装完成！"
echo ""
echo "使用方法："
echo "  1. 确保 Harness House 在运行: cd $PROJECT_DIR && npm run dev"
echo "  2. 启动 Hermes: hermes"
echo "  3. 开启语音: /voice on"
echo "  4. 说话试试: \"你好\" \"关客厅灯\" \"太亮了\""
echo ""
echo "提示："
echo "  - 第一次需要 /reset 让 tool 生效"
echo "  - Mac Mini 内置麦克风先凑合，后续可加 USB 麦克风阵列"
echo "  - 设备控制延迟 ~1.5秒，闲聊 ~1秒（首字）"
