# Version Workflow

> 每个版本都按同一节奏推进，避免 AI、adapter、UI 和真实设备控制混在一起改。

## 1. 版本入口

每个版本开始前写清楚：

```text
Version:
Goal:
Affected layers:
Non-goals:
Real-device impact:
Intent / policy impact:
Provider / adapter impact:
Acceptance tests:
Rollback plan:
Docs to update:
```

## 2. 标准节奏

```text
Design Brief
  -> Architecture Check
  -> Contract Tests
  -> Implementation
  -> Simulation Verification
  -> Read-only Provider Verification
  -> Intent / Safety / Policy Verification
  -> UI/3D Verification
  -> Docs Update
  -> Review
  -> Commit + Push
```

## 3. 任务拆分规则

单个任务应该能在一个明确边界内完成：

- 一个 schema 或 mapper。
- 一个 adapter 行为。
- 一个 safety rule。
- 一个 intent accuracy 或 policy rule。
- 一个 UI panel。
- 一个 replay / audit 行为。

不要在同一任务里同时改：

- LLM prompt 和 executor。
- adapter 和 3D layout。
- safety policy 和样式。
- policy gate 和 provider adapter。
- digital twin 可视化和真实执行权限。
- real execution 和 learning activation。

## 4. Review Checklist

提交前检查：

- 是否绕过 HCM 直接使用 provider entity？
- 是否让 LLM 决定真实 service？
- 是否新增真实设备副作用？
- 是否有 simulator 或 dry-run 覆盖？
- 是否新增或改变 intent accuracy / safety / policy gate？
- 是否有风险等级和确认策略？
- 是否会把本地 HA 快照、token、家庭设备明细提交？
- UI 是否能解释“为什么执行/为什么拒绝”？
- README / ROADMAP / TEST_CASES / CURRENT_STATUS 是否需要同步？

## 5. 发布说明模板

```text
## Changed

## Safety

## Tests

## Known limits

## Next
```

## 6. Git 规则

- 每次提交只包含一个主题。
- 文档、运行逻辑、依赖升级尽量分开提交。
- 不提交 `.env`、HA snapshot、overlay、token、家庭私有设备数据。
- 发现无关工作区变更时，不回滚、不混入提交。
