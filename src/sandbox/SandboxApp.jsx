import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AudioLines, BookOpen, ChevronDown, Download, Fan, House, LampCeiling, Layers, LoaderCircle, Mic, MicOff, Play, RefreshCw, RotateCcw, Send, Sparkles, Tv, Upload, UserRound, Volume2, VolumeX, Footprints } from "lucide-react";
import SandboxScene from "./SandboxScene.jsx";
import { HOUSE_BLUEPRINT, actorRoom } from "./houseBlueprint.js";
import { sandboxDevices, sandboxDeviceStatus as deviceStatus, deviceIsOn } from "./sandboxDeviceView.js";
import { assessSpeechTranscript, createBrowserSpeechInput, createBrowserSpeechOutput } from "../speechRuntime.js";

const errors = { runtime_busy: "沙盒正在处理上一项操作。", stale_clarification: "上一条问题已失效，请重新说明。", invalid_actor_pose: "当前位置不能作为有效发言位置。", incomplete_recording: "轨迹不完整，请重新开始后录制不超过 20 轮。", invalid_recording: "这不是有效的沙盒轨迹文件。", command_id_conflict: "请求标识冲突，请重新发送。", recording_baseline_mismatch: "这条轨迹来自不同的家庭快照，不能在当前副本回放。" };
const haErrors = { ha_hostname_unavailable: "HA 地址无法解析", ha_unavailable: "HA 暂时不可达", ha_timeout: "HA 连接超时", ha_authentication_failed: "HA 令牌需更新", ha_not_configured: "HA 未配置", invalid_saved_layout: "户型数据需检查" };
const formatTime = value => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未同步";
const statuses = { executed: "已模拟执行", answered: "已回答", needs_clarification: "待补充", failed: "未执行", execution_unknown: "结果待核实", cancelled: "已取消", dry_run: "仅预演" };
async function api(path, body) {
  const response = await fetch(`/api/sandbox/${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(errors[result.error] ?? result.error ?? "沙盒服务暂时不可用。");
  return result;
}

export default function SandboxApp() {
  const [snapshot, setSnapshot] = useState(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneError, setSceneError] = useState("");
  const [actor, setActor] = useState(HOUSE_BLUEPRINT.spawn);
  const [view, setView] = useState("overview");
  const [overviewRevision, setOverviewRevision] = useState(0);
  const [direction, setDirection] = useState({ x: 0, z: 0 });
  const [resetRevision, setResetRevision] = useState(0);
  const [teleport, setTeleport] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [tts, setTts] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(null);
  const pendingRoom = useRef(null);
  const [tab, setTab] = useState("chat");
  const [recordingCount, setRecordingCount] = useState(0);
  const [replayResults, setReplayResults] = useState([]);
  const [playback, setPlayback] = useState(null);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [inspectionRoom, setInspectionRoom] = useState(null);
  const [destination, setDestination] = useState(null);
  const [referenceDevices, setReferenceDevices] = useState([]);
  const [latestResult, setLatestResult] = useState(null);
  const actorRef = useRef(actor);
  const session = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const scroll = useRef(null);
  const upload = useRef(null);
  const mounted = useRef(true);
  const speechTurn = useRef(0);
  const speechInput = useMemo(() => createBrowserSpeechInput(), []);
  const speechOutput = useMemo(() => createBrowserSpeechOutput(), []);
  const displaySnapshot = playback ?? snapshot;
  const blueprint = displaySnapshot?.blueprint ?? HOUSE_BLUEPRINT;
  const isReplica = blueprint.kind === "ha-replica";
  const roomId = actorRoom(actor, blueprint);
  const roomName = blueprint.rooms.find((room) => room.id === roomId)?.name ?? "门口 · 位置不确定";
  const devices = useMemo(() => displaySnapshot ? sandboxDevices(displaySnapshot.home, displaySnapshot.blueprint ?? HOUSE_BLUEPRINT) : [], [displaySnapshot]);
  const visibleDevices = devices.filter(device => device.roomId === (inspectionRoom ?? roomId) && (isReplica || device.capabilities.some(capability => capability.access === "execute")));
  const lightCount = devices.filter(device => device.type === "light" && deviceIsOn(device)).length;
  useEffect(() => {
    mounted.current = true;
    api("state").then((data) => { if (mounted.current) { setSnapshot(data.snapshot); updateActor(data.snapshot.blueprint?.spawn ?? HOUSE_BLUEPRINT.spawn); setRecordingCount(data.recordingCount); } }).catch((error) => setError(error.message));
    return () => { mounted.current = false; speechTurn.current += 1; speechInput.stop(); speechOutput.stop(); };
  }, [speechInput, speechOutput]);
  useEffect(() => {
    if (snapshot?.source?.kind !== "ha") return;
    const timer = setInterval(() => api("source/status").then(data => { if (mounted.current) setSnapshot(current => ({ ...current, source: { ...data.source, copyCapturedAt: current.home.syncedAt, updateAvailable: data.source.latestBaselineId !== current.baselineId } })); }).catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [snapshot?.source?.kind]);
  useEffect(() => {
    if (!selectedDevice || snapshot?.source?.kind !== "ha") return;
    let cancelled = false;
    api("reference").then(data => { if (!cancelled) setReferenceDevices(data.devices); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedDevice, snapshot?.source?.capturedAt, snapshot?.source?.kind]);
  useEffect(() => { setSceneReady(false); setSceneError(""); }, [blueprint.id]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages, tab, busy]);
  useEffect(() => {
    const log = scroll.current;
    if (!log) return;
    const observer = new ResizeObserver(() => { log.scrollTop = log.scrollHeight; });
    observer.observe(log);
    return () => observer.disconnect();
  }, [tab]);
  useEffect(() => { if (pending && roomId !== pendingRoom.current) setPending(null); }, [roomId, pending]);
  useEffect(() => setSelectedDevice(null), [roomId]);
  const updateActor = (pose) => { actorRef.current = pose; setActor(pose); };
  const submit = async (text = input, source = "text", pose = actorRef.current) => {
    if (!text.trim() || inFlight.current || !snapshot || !sceneReady) return;
    inFlight.current = true; setBusy(true); setError(""); setTab("chat");
    speechTurn.current += 1; speechInput.stop(); speechOutput.stop(); setListening(false);
    const commandId = crypto.randomUUID();
    setInput("");
    setMessages((current) => [...current, { id: `${commandId}-user`, role: "user", text, room: blueprint.rooms.find((room) => room.id === actorRoom(pose, blueprint))?.name ?? "门口", source }].slice(-60));
    const started = performance.now();
    try {
      const data = await api("command", { sessionId: session.current, commandId, input: text, pose, source, ...(pending ? { resumeFor: pending } : {}) });
      const result = data.result;
      setSnapshot(data.snapshot); setRecordingCount(data.recordingCount); setLatestResult(result);
      setPending(result.status === "needs_clarification" ? commandId : null);
      pendingRoom.current = actorRoom(pose, blueprint);
      const reply = statuses[result.status] ? result.summary : "没有操作设备。";
      setMessages((current) => [...current, { id: commandId, role: "assistant", text: reply, status: result.status, elapsed: Math.round(performance.now() - started) }].slice(-60));
      if (tts && !["failed", "execution_unknown"].includes(result.status)) speechOutput.speak(reply, { key: commandId });
    } catch (error) { setError(error.message); setMessages((current) => [...current, { id: commandId, role: "assistant", text: `未执行：${error.message}`, status: "failed" }]); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const microphone = () => {
    if (listening) { speechTurn.current += 1; speechInput.stop(); setListening(false); return; }
    setError(""); speechOutput.stop();
    const voicePose = { ...actorRef.current };
    const turn = ++speechTurn.current;
    let finalized = false;
    const active = () => mounted.current && turn === speechTurn.current;
    setListening(true);
    speechInput.start({ onEnd: () => { if (active()) { speechTurn.current += 1; setListening(false); } }, onError: (error) => { if (active()) { speechTurn.current += 1; setError(error.message); setListening(false); } }, onResult: (result) => {
      if (!active() || finalized) return;
      setInput(result.transcript);
      if (!result.isFinal) return;
      finalized = true;
      const assessment = assessSpeechTranscript(result);
      if (assessment.ok) submit(assessment.transcript, "voice", voicePose);
      else { speechTurn.current += 1; speechInput.stop(); setListening(false); setError("识别置信度不足，请核对文字后发送。"); }
    } });
  };
  const reset = async () => {
    if (inFlight.current || !window.confirm(isReplica ? "从最新 HA 参考快照建立新的模拟副本，并清空对话和轨迹。不会操作真实设备。继续吗？" : "重新开始会重置样板设备、对话和轨迹。继续吗？")) return;
    inFlight.current = true; setBusy(true); speechTurn.current += 1; speechInput.stop(); speechOutput.stop(); setListening(false);
    try {
      const data = await api("reset", {}); setSnapshot(data.snapshot); setMessages([]); setPending(null); setLatestResult(null); setRecordingCount(0); setReplayResults([]); setPlayback(null); setInput(""); setError("");
      session.current = crypto.randomUUID(); setResetRevision((revision) => revision + 1); setTeleport(null); setDestination(null); setInspectionRoom(null); setSelectedDevice(null); updateActor(data.snapshot.blueprint?.spawn ?? HOUSE_BLUEPRINT.spawn);
    } catch (error) { setError(error.message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const refreshSource = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { const data = await api("source/refresh", {}); setSnapshot(data.snapshot); }
    catch (failure) { setError(failure.message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const exportRecording = async () => {
    try {
      const data = await api("recording");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "harness-house-scene.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError(error.message); }
  };
  const replay = async (recording) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setTab("trace");
    speechTurn.current += 1; speechInput.stop(); speechOutput.stop(); setListening(false);
    const before = { ...actorRef.current };
    try {
      const data = await api("replay", recording ?? await api("recording"));
      setReplayResults(data.results);
      const run = crypto.randomUUID();
      for (const [index, frame] of data.results.entries()) {
        if (!mounted.current) break;
        setPlayback(frame.snapshot); setTeleport({ key: `${run}-${index}`, pose: frame.pose });
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    } catch (error) { setError(error.message); }
    finally { if (mounted.current) { setPlayback(null); setTeleport({ key: `restore-${crypto.randomUUID()}`, pose: before }); setBusy(false); } inFlight.current = false; }
  };
  const importRecording = async (event) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    try { if (file.size > 512 * 1024) throw new Error("轨迹文件不能超过 512 KB。"); await replay(JSON.parse(await file.text())); }
    catch (error) { setError(error.message); }
  };
  const holdDirection = (event, x, z) => { event.currentTarget.setPointerCapture(event.pointerId); setDirection({ x, z }); };
  const stopDirection = () => setDirection({ x: 0, z: 0 });
  const selected = devices.find((device) => device.id === selectedDevice);
  const reference = referenceDevices.find(device => device.id === selectedDevice);
  const selectDevice = id => { const device = devices.find(d => d.id === id); if (device) { setInspectionRoom(device.roomId); setSelectedDevice(id); } };
  return <main className="sandbox-app">
    <header className="sandbox-header">
      <div className="sandbox-brand"><span className="brand-icon"><House size={21} /></span><div><h1>Harness House</h1><span>家庭沙盒</span></div></div>
      <div className="sandbox-header-state">{isReplica && <span className={`ha-badge ${snapshot?.source?.connectionState === "live" ? "live" : "cached"}`}>{snapshot?.source?.connectionState === "live" ? "HA 只读连接" : snapshot?.source?.kind === "fixture" ? "HA 测试目录" : "HA 历史快照"}</span>}<span className="simulation-badge"><span />模拟设备</span><span className="model-badge"><Sparkles size={14} />本地 D1</span></div>
      <button className="icon-button" onClick={reset} disabled={busy} title="重新开始" aria-label="重新开始"><RotateCcw size={18} /></button>
    </header>
    <div className="sandbox-workspace">
      <section className="sandbox-world" aria-label="家庭三维场景">
        <div className="world-toolbar"><div className="location-indicator"><UserRound size={15} /><strong>住户</strong><span className="location-separator" /><span data-testid="actor-room">{roomName}</span></div>
          <div className="view-switch" aria-label="场景视角"><button className={view === "overview" ? "selected" : ""} onClick={() => { setView("overview"); setOverviewRevision(revision => revision + 1); }} title="全屋视角" aria-pressed={view === "overview"}><Layers size={15} />全屋</button><button className={view === "follow" ? "selected" : ""} onClick={() => setView("follow")} title="跟随人物" aria-pressed={view === "follow"}><UserRound size={15} />跟随</button></div>
        </div>
        {displaySnapshot && <SandboxScene snapshot={displaySnapshot} controls={{ mode: view, overviewRevision, locked: busy || listening, direction, resetRevision, teleport, destination, focusDeviceId: selectedDevice }} onPose={updateActor} onReady={() => setSceneReady(true)} onError={setSceneError} onDevice={selectDevice} />}
        {!sceneReady && <div className="scene-loading">{sceneError ? <span>{sceneError}</span> : <><LoaderCircle className="spin" size={21} /><span>载入房屋</span></>}</div>}
        <div className="world-footer"><div className="room-legend">{isReplica ? <span><House size={14} />{blueprint.rooms.length} 区域 · {blueprint.devices.length} 设备点</span> : <><span><BookOpen size={14} />书房</span><span><House size={14} />客厅</span></>}</div><div className="world-stats">{playback ? <span className="playback-badge">回放</span> : <><span className="green-dot" />{lightCount} 盏灯开启</>}</div></div>
        <div className="movement-pad" aria-label="人物移动">{[[ArrowUp, 0, -1, "前移"], [ArrowLeft, -1, 0, "左移"], [ArrowDown, 0, 1, "后移"], [ArrowRight, 1, 0, "右移"]].map(([Icon, x, z, name]) => <button key={name} className={`move-${name}`} disabled={!sceneReady || busy || listening} title={name} aria-label={name} onPointerDown={(event) => holdDirection(event, x, z)} onPointerUp={stopDirection} onPointerCancel={stopDirection} onBlur={stopDirection}><Icon size={18} /></button>)}</div>
      </section>
      <aside className="sandbox-console">
        {snapshot?.source?.kind === "ha" && <section className="sandbox-source" aria-label="HA 数据来源"><div className="source-heading"><strong>{snapshot.source.connectionState === "live" ? "HA 参考快照" : snapshot.source.connectionState === "syncing" ? "正在读取 HA" : "HA 离线缓存"}</strong><button className="icon-button" aria-label="同步 HA 目录" title="只读同步 HA 目录和状态" disabled={busy} onClick={refreshSource}><RefreshCw size={14} /></button></div><span>{snapshot.source.physicalDeviceCount} 台设备 · {snapshot.source.logicalAssetCount} 个受控对象</span><span>参考时间 {formatTime(snapshot.source.capturedAt)}</span>{snapshot.source.error && <small>{haErrors[snapshot.source.error] ?? "HA 连接待检查"}</small>}{snapshot.source.updateAvailable && <button className="source-update" onClick={reset} disabled={busy}><RefreshCw size={13} />载入新快照</button>}<small>真实控制关闭 · 模拟副本独立</small></section>}
        <div className="console-heading"><div><AudioLines size={18} /><h2>与家对话</h2></div><span className={busy ? "status-busy" : "status-ready"}>{busy ? "处理中" : "就绪"}</span></div>
        <div className="console-tabs" role="tablist"><button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>对话</button><button role="tab" aria-selected={tab === "trace"} className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>场景轨迹<span>{recordingCount}</span></button></div>
        {tab === "chat" ? <>
          <div className="sandbox-messages" ref={scroll} role="log" aria-live="polite">{!messages.length && <div className="empty-chat"><span className="house-outline"><House size={30} /></span><h3>住户在{roomName}</h3><span>{isReplica ? "我的家 · 模拟副本" : "样板房 · 内存模拟"}</span></div>}{messages.map((message) => <article key={message.id} className={`message ${message.role}`}><div className="message-meta"><span>{message.role === "user" ? `${message.room} · ${message.source === "voice" ? "语音" : "文字"}` : "Harness House"}</span>{message.status && <span>{statuses[message.status]}</span>}</div><p>{message.text}</p>{message.elapsed !== undefined && <small>{message.elapsed} ms</small>}</article>)}{busy && !playback && <div className="thinking"><LoaderCircle size={14} className="spin" /><span>正在处理</span></div>}</div>
          <div className="composer-zone">{pending && <div className="pending-label"><span className="amber-dot" />回复上一轮问题<button type="button" onClick={() => setPending(null)}>新话题</button></div>}{error && <div role="alert" className="sandbox-error">{error}</div>}{listening && <div className="listening-state"><span className="green-dot" />正在听</div>}
            <form className="sandbox-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}><input aria-label="对住户所在房间发出指令" placeholder="开灯 / 还是太暗 / 关掉刚才那盏" value={input} onChange={(event) => setInput(event.target.value)} disabled={busy} maxLength={500} /><button className="send-button" disabled={!input.trim() || busy || !sceneReady || !snapshot} title="发送" aria-label="发送"><Send size={17} /></button></form>
            <div className="composer-tools"><span><UserRound size={12} />{roomName}</span><div><button className={`icon-button ${listening ? "is-active" : ""}`} type="button" onClick={microphone} disabled={!speechInput.supported || busy || !sceneReady || !snapshot} title="浏览器语音输入，识别服务可能需要联网" aria-label={listening ? "停止语音输入" : "开始语音输入"}>{listening ? <MicOff size={17} /> : <Mic size={17} />}</button><button className={`icon-button ${tts ? "is-active" : ""}`} onClick={() => { setTts(!tts); if (tts) speechOutput.stop(); }} disabled={!speechOutput.supported} title={tts ? "关闭播报" : "开启播报"} aria-label={tts ? "关闭播报" : "开启播报"}>{tts ? <Volume2 size={17} /> : <VolumeX size={17} />}</button></div></div>
          </div>
        </> : <div className="trace-panel"><div className="trace-tools"><button className="tool-command" onClick={() => replay()} disabled={!recordingCount || busy}><Play size={14} />回放</button><button className="icon-button" title="导出轨迹" aria-label="导出轨迹" onClick={exportRecording} disabled={!recordingCount || busy}><Download size={17} /></button><button className="icon-button" title="导入并回放" aria-label="导入并回放" onClick={() => upload.current.click()} disabled={busy}><Upload size={17} /></button><input ref={upload} type="file" hidden accept="application/json,.json" onChange={importRecording} /></div>{error && <div role="alert" className="sandbox-error">{error}</div>}{!replayResults.length ? <div className="trace-empty">{recordingCount ? `${recordingCount} 轮交互已记录` : "暂无交互轨迹"}</div> : replayResults.map((entry, index) => <div className="trace-row" key={index}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{entry.input}</strong><p>{entry.result.summary}</p></div><small className={entry.matches ? "match" : "difference"}>{entry.matches ? "一致" : "差异"}</small></div>)}</div>}
        <section className="sandbox-device-section"><div className="section-heading"><h2>房间设备</h2><span>{visibleDevices.length} 项</span></div>{isReplica && <div className="device-scope"><select aria-label="查看房间设备" value={inspectionRoom ?? "actor"} onChange={event => { setInspectionRoom(event.target.value === "actor" ? null : event.target.value); setSelectedDevice(null); }}><option value="actor">随住户 · {roomName}</option>{blueprint.rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}{devices.some(d => !blueprint.rooms.some(r => r.id === d.roomId)) && <option value="unknown">未分区</option>}</select><button className="icon-button" aria-label="走到所选房间" title="走到所选房间" disabled={busy || listening || !sceneReady || !blueprint.roomSpawns[inspectionRoom]} onClick={() => { setSelectedDevice(null); setDestination({ key: crypto.randomUUID(), pose: blueprint.roomSpawns[inspectionRoom] }); }}><Footprints size={16} /></button></div>}<div className="sandbox-devices">{visibleDevices.map((device) => { const Icon = device.type === "light" ? LampCeiling : device.type === "fan" ? Fan : device.type === "tv" ? Tv : House; return <button key={device.id} className={`device-row ${selectedDevice === device.id ? "selected" : ""}`} onClick={() => setSelectedDevice(selectedDevice === device.id ? null : device.id)} aria-expanded={selectedDevice === device.id}><span className="device-icon"><Icon size={16} /></span><span>{device.name}</span><strong className={deviceStatus(device) === "开启" ? "on" : ""}>{deviceStatus(device)}</strong><ChevronDown size={13} /></button>; })}</div>{selected && <div className="device-details"><strong>{selected.name}</strong>{reference && <div className="reference-value"><span>HA 参考快照</span><span>{deviceStatus(reference)}</span></div>}<div><span>模拟副本</span><span>{deviceStatus(selected)}</span></div>{selected.capabilities.slice(0, 6).map(capability => <div key={capability.id}><span>{capability.name}</span><span>{capability.access === "execute" ? "模拟可控" : "只读"} · {typeof capability.state === "boolean" ? capability.state ? "是" : "否" : String(capability.state ?? "未知")}</span></div>)}{selected.capabilities.length > 6 && <details><summary>全部 {selected.capabilities.length} 项能力</summary><div className="capability-list">{selected.capabilities.map(capability => <div key={capability.id}><span>{capability.name}</span><span>{capability.access === "execute" ? "模拟可控" : "只读"}</span></div>)}</div></details>}{selected.controller && <span>控制器：{selected.controller.name} · {({ left: "左键", middle: "中键", right: "右键" })[selected.controller.channel] ?? selected.controller.channel}</span>}</div>}</section>
        {latestResult && <details className="decision-details"><summary>本轮决策记录</summary><dl><dt>范围来源</dt><dd>{({ terminal: "发言终端", explicit_room: "明确房间", conversation_target: "对话目标", conversation_room: "对话房间", ambiguous_origin: "位置不确定" })[latestResult.d1?.scope?.source] ?? "未明确"}</dd><dt>候选方案</dt><dd>{latestResult.d1?.candidateCount ?? "—"}</dd><dt>模型分数</dt><dd>{latestResult.d1?.probability?.toFixed(3) ?? "—"}</dd><dt>执行结果</dt><dd>{statuses[latestResult.status] ?? latestResult.status}</dd></dl></details>}
      </aside>
    </div>
  </main>;
}
