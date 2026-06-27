# 3D House V2 设计文档

> 日期: 2026-06-22
> 状态: Draft (待用户确认后实施)

## 一、现状分析

### 1.1 当前架构

| 组件 | 文件 | 行数 | 问题 |
|------|------|------|------|
| 3D 渲染 | `src/ThreeHouse.jsx` | 704 | 设备为原始几何体、墙体半透明无质感、标签密集 |
| 场景模型 | `src/houseSceneModel.js` | 454 | 房间只有 x/z/width/depth，无多边形 |
| 地图编辑器 | `src/spatialHomeEditor.js` | 740 | 房间只有 mapRect (left/top/width/height)，不支持不规则形状 |
| 模拟器 | `src/simulator.js` | 973 | rooms 数组用方正矩形定义 |

### 1.2 问题诊断

**问题 1: 房间只能用方正矩形**
- `ROOM_LAYOUTS` 硬编码 x/z/width/depth
- `spatialHomeEditor.js` 的 `mapRect` = `{left, top, width, height}`
- `findSpatialRoomAtPoint` 用矩形碰撞检测
- 现实中 L 形走廊、不规则卫生间无法表达

**问题 2: 3D 缺乏基础审美**
- 墙体: `BoxGeometry` 高 0.75m (实际应 2.7m)，opacity 0.48 几乎看不见
- 地面: 纯色 `MeshStandardMaterial`，无木地板/瓷砖纹理
- 设备:
  - 灯 = 浮空球体 (`SphereGeometry`)，不像灯具
  - 风扇 = 圆柱+3个方块叶片，比例不对
  - 空调 = 扁平方块，无壁挂形态
  - 传感器 = 圆柱+环，抽象
- 家具: 纯方块，无质感

**问题 3: 选中房间信息过载**
- `shouldShowDeviceLabel` 对选中房间所有设备返回 true
- 每个设备生成 250×72px 文字标签 (名称+状态)
- 主卧 10 个设备 = 10 个浮空文字标签
- 左侧栏 DeviceList 也同时列出所有设备文字
- 3D 场景变成"文字墙"

---

## 二、设计方案

### 2.1 Map Editor: 不规则多边形房间

#### 数据模型变更

```javascript
// 现有 (矩形):
roomRects = { 
  roomId: { left, top, width, height, centerX, centerY } 
}

// 新增 (多边形):
roomPolygons = {
  roomId: {
    points: [{x, y}, {x, y}, ...],  // 百分比坐标，顺时针
    centerX: x,  // 质心，用于设备默认放置
    centerY: y,
  }
}
```

**向后兼容**: 有 `roomPolygons` 用多边形，否则回退到 `roomRects`（矩形自动转为 4 点多边形）。

#### 交互流程

1. 点击「新增房间」→ 选择「多边形」模式
2. 在地图上点击放置顶点（显示连线预览）
3. 双击或点击起点 → 闭合多边形
4. 可拖拽顶点微调
5. 至少 3 个顶点才能闭合

#### 碰撞检测

```javascript
// 替换 findSpatialRoomAtPoint 的矩形检测
function pointInPolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
```

#### 3D 渲染

```javascript
// 多边形房间用 ExtrudeGeometry
const shape = new THREE.Shape();
shape.moveTo(points[0].x, points[0].z);
for (let i = 1; i < points.length; i++) {
  shape.lineTo(points[i].x, points[i].z);
}
shape.closePath();
const floorGeo = new THREE.ShapeGeometry(shape);  // 地面
const wallGeo = new THREE.ExtrudeGeometry(shape, { depth: WALL_HEIGHT, bevelEnabled: false });
```

### 2.2 3D 视觉升级

#### 比例修正 — 娃娃屋模式 (Dollhouse Cutaway)

> 核心原则: 墙体要有实感但不能挡住设备。采用娃娃屋模式 — 墙高低于真实层高，俯视角可看到室内所有内容。

| 参数 | 当前值 | 修正值 | 说明 |
|------|--------|--------|------|
| 墙高 (未选中) | 0.75 | 1.1 | 足够有墙体实感，不挡设备 |
| 墙高 (选中房间) | 0.75 | 0.3 | 选中后"敞开"，看到全部内容 |
| 墙厚 | 0.07 | 0.12 | 真实墙厚 12cm |
| 墙透明度 (未选中) | 0.48 | 0.88 | 实感 |
| 墙透明度 (选中) | 0.88 | 0.3 | 透视进去 |
| 设备高度 | 不统一 | 见下 | 灯具贴天花板，传感器贴墙 |

#### 墙体设计

- 材质: `MeshStandardMaterial`，color 0xf5f5f0 (暖白墙漆)
- roughness 0.9, metalness 0
- 选中时: 墙高降到 0.3m + opacity 0.3 + 淡蓝色 emissive
- 未选中: 墙高 1.1m + opacity 0.88
- **不对外墙面** (俯视看室内)，只渲染内墙

#### 地面设计

按房间类型生成 Canvas 纹理:

| 房间类型 | 纹理风格 | 色调 |
|----------|----------|------|
| 客厅/餐厅 | 木地板 (横向木纹) | 暖棕 #c4a373 |
| 卧室 | 木地板 (浅色) | 浅棕 #d4bc94 |
| 厨房/卫生间 | 方瓷砖 (网格线) | 浅灰 #e0e0e0 |
| 阳台 | 防滑地砖 | 灰色 #c4c4c4 |
| 书房 | 木地板 (深色) | 深棕 #a68a64 |
| 入户/过道 | 石材纹理 | 米白 #e8e2d8 |

```javascript
function createFloorTexture(roomType) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  // 按类型绘制不同图案
  if (roomType === 'bath' || roomType === 'kitchen') {
    // 瓷砖: 画网格线
    ctx.fillStyle = '#e0e0e0';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#c0c0c0';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
  } else {
    // 木地板: 画横向条纹
    const colors = { living: '#c4a373', bedroom: '#d4bc94', study: '#a68a64' };
    ctx.fillStyle = colors[roomType] || '#c4a373';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 256; i += 32) {
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
    // 木纹噪声
    for (let i = 0; i < 200; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, Math.random() * 40 + 10, 2);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}
```

#### 设备实体建模

**灯 (light) — 按子类型分别建模**

通过 `device.name` 判断子类型:

| 子类型 | 判断 | 3D 形态 | 尺寸 |
|--------|------|---------|------|
| 吊灯 | 名称含"吊灯" | 吊杆(Φ0.02×0.3) + 灯罩(半球Φ0.14) + 内部光源 | 下垂至 y≈2.3 |
| 射灯 | 名称含"射灯" | 嵌入天花板筒灯(Φ0.06×0.04) + 方向光束 | 贴天花板 y≈2.65 |
| 灯带 | 名称含"灯带" | 线性发光条(0.6×0.02×0.04) + emissive | 贴墙角 y≈2.5 |
| 吸顶灯 | 名称含"吸顶灯" | 扁平圆盘(Φ0.15×0.04) + 磨砂罩 | 贴天花板 y≈2.65 |
| 落地灯 | 名称含"落地灯" | 底座(Φ0.08) + 灯杆(Φ0.02×1.5) + 锥形灯罩 | 落地 y=0~1.8 |
| 默认 | 其他 | 吸顶灯形态 (fallback) | 同吸顶灯 |

```javascript
function getLightSubType(device) {
  const name = device.name || "";
  if (name.includes("吊灯")) return "pendant";
  if (name.includes("射灯")) return "spotlight";
  if (name.includes("灯带")) return "strip";
  if (name.includes("吸顶灯")) return "ceiling";
  if (name.includes("落地灯")) return "floor";
  return "ceiling"; // fallback
}
```

各子类型建模细节:

```
吊灯 (pendant):
  吊杆: CylinderGeometry(0.02, 0.02, 0.3) 银色 → y=2.5~2.8
  灯罩: SphereGeometry(0.14) 下半球 半透明磨砂 → y=2.35
  光源: PointLight + 发光球 → y=2.35
  关闭: 灰色灯罩
  开启: 暖黄色灯罩+点光源+光晕

射灯 (spotlight):
  筒体: CylinderGeometry(0.05, 0.06, 0.04) 白色 → 贴天花板 y=2.63
  光束: SpotLight, 方向朝下, 角度 30°
  关闭: 灰色筒体
  开启: 中心发光+方向光束

灯带 (strip):
  灯条: BoxGeometry(0.6, 0.02, 0.04) → 贴墙角 y=2.5
  关闭: 暗灰色
  开启: emissive 线性发光, 均匀柔光

吸顶灯 (ceiling):
  底盘: CylinderGeometry(0.15, 0.15, 0.03) 白色 → 贴天花板 y=2.63
  灯罩: SphereGeometry(0.12) 下半球 磨砂 → y=2.55
  光源: PointLight → y=2.5
  关闭: 灰色
  开启: 暖黄色+光晕

落地灯 (floor):
  底座: CylinderGeometry(0.08, 0.1, 0.03) 深色 → 地面 y=0.03
  灯杆: CylinderGeometry(0.02, 0.02, 1.5) 银色 → y=0.03~1.53
  灯罩: ConeGeometry(0.12, 0.15) 半透明 → y=1.5
  光源: PointLight → y=1.4
```

**风扇 (fan)** — 吊扇形态:
```
吊杆: CylinderGeometry(0.02, 0.02, 0.3) 银色
电机壳: CylinderGeometry(0.08, 0.08, 0.1) 银色
叶片: 3片 BoxGeometry(0.35, 0.02, 0.08) 木纹色, 旋转角度间隔120°
开启时: 叶片绕Y轴旋转
```

**空调 (ac)** — 壁挂式:
```
机身: BoxGeometry(0.6, 0.18, 0.2) 白色 → 挂墙上部
出风口: BoxGeometry(0.5, 0.04, 0.05) 深色, 机身底部
显示屏: 小平面, 显示温度数字
导风板: 薄片可旋转角度表示风向
```

**传感器 (sensor)** — 小圆盘:
```
底座: CylinderGeometry(0.04, 0.04, 0.02) 白色 → 贴天花板
LED: 小球体, 有人=绿色发光, 无人=灰色
```

**电视 (tv)** — 立式:
```
支架: BoxGeometry(0.3, 0.3, 0.04) 黑色
屏幕: BoxGeometry(0.8, 0.45, 0.04) 深色 → 开启时蓝色emissive
```

**扫地机器人 (robot_vacuum)** — 圆盘:
```
机身: CylinderGeometry(0.17, 0.17, 0.08) 黑色金属
高度: 0.08 (真实7-8cm)
清扫中: 绕随机方向微移动
```

### 2.3 信息显示优化：三层信息架构

**核心原则: 用视觉替代文字, 用交互替代堆叠**

#### 层级 1: 默认视图 (At-a-glance)

选中房间时, 3D 场景中只显示:
- 房间名标签 (已有, 保留)
- 设备状态点: 每个设备一个小圆点 (直径 0.08m)
  - 🟢 绿色 = 活跃
  - ⚪ 灰色 = 关闭
  - 🔴 红色 = 告警
  - 🟡 琥珀 = 执行中
- 房间摘要徽章: "4 设备 · 2 活跃" (单个标签, 不是 4 个)

**删除**: 每个设备单独的名称+状态文字标签

#### 层级 2: 悬停详情 (Hover)

鼠标悬停在设备上时:
- 设备 3D 模型高亮 (emissive 增强)
- 浮出一个小型信息卡 (HTML overlay, 非 3D sprite):
  - 设备名称
  - 当前状态
  - 离开 hover 区域后消失

#### 层级 3: 点击详情 (Click)

点击设备时:
- 3D 中设备被选中 (高亮环)
- 左侧栏 DeviceCapabilityPanel 显示详情 (已有)
- 其他设备降为低对比度

#### 代码变更

```javascript
// shouldShowDeviceLabel 改为: 不在 3D 中显示文字标签
function shouldShowDeviceLabel(device, active, selectedRoomId) {
  return false; // V2: 不再在 3D 中显示文字标签
}

// 新增: 设备状态点
function addDeviceStatusDot(group, device, x, z, active) {
  const color = device.alert ? 0xef4444 
    : device.executing ? 0xf59e0b
    : active ? 0x22c55e 
    : 0x94a3b8;
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 16),
    new THREE.MeshBasicMaterial({ color })
  );
  dot.position.set(x, 2.6, z); // 靠近天花板
  group.add(dot);
}

// 新增: 房间摘要徽章 (替代多个设备标签)
function addRoomSummaryBadge(group, room, deviceCount, activeCount) {
  const label = createTextSprite(`${room.name} · ${activeCount}/${deviceCount}`, {
    width: 200, height: 50, fontSize: 18,
    background: "rgba(255,255,255,0.85)",
    foreground: "#314b47",
  });
  label.position.set(room.x, 2.85, room.z);
  group.add(label);
}
```

---

## 三、实施顺序

1. **Task 3 (信息显示)** — 最快见效, 改动集中在 ThreeHouse.jsx
2. **Task 2 (视觉升级)** — 中等工作量, 需要写纹理生成+设备建模函数
3. **Task 1 (多边形房间)** — 最大工作量, 涉及数据模型+编辑器+3D渲染

每个 Task 完成后: 验证 → 提交 → 更新本文档状态

## 四、文件影响清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/ThreeHouse.jsx` | 重构 | 设备建模、纹理、信息架构 |
| `src/spatialHomeEditor.js` | 扩展 | 多边形数据模型、碰撞检测 |
| `src/houseSceneModel.js` | 扩展 | 多边形房间支持 |
| `src/App.jsx` | 小改 | 地图编辑器多边形绘制 UI |
| `src/styles.css` | 小改 | hover overlay 样式 |
| `docs/3D-HOUSE-V2-DESIGN.md` | 新增 | 本文档 |
