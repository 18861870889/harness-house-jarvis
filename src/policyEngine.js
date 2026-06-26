const NUMERIC_RANGES = {
  climate: [16, 30],
  cover: [0, 100],
  light: [0, 100],
  fan: [0, 100],
};

const PROTECTED_TYPES = new Set(["camera", "gas_heater", "water_heater"]);
const LONG_RUNNING_TYPES = new Set(["washer", "dryer", "robot_vacuum"]);

export function evaluateExecutionPolicy({
  plan,
  executionPlan,
  context,
  source = "chat",
  now = new Date(),
} = {}) {
  const accepted = [];
  const policyRejected = [];
  const decisions = [];

  for (const item of executionPlan?.accepted ?? []) {
    const decision = evaluateAcceptedItem(item, { plan, context, source, now });
    decisions.push(decision);
    if (decision.ok) {
      accepted.push({
        ...item,
        policyDecision: decision,
      });
    } else {
      policyRejected.push({
        ok: false,
        code: decision.code,
        message: decision.message,
        action: item.action,
        thingId: item.thing?.id,
        thingName: item.thing?.name,
        capabilityId: item.capability?.id,
        capabilityName: item.capability?.name,
      });
    }
  }

  return {
    ok: accepted.length > 0,
    accepted,
    rejected: [...(executionPlan?.rejected ?? []), ...policyRejected],
    decisions,
    summary: {
      acceptedCount: accepted.length,
      rejectedCount: policyRejected.length,
      source,
      policyCodes: policyRejected.map((item) => item.code),
    },
  };
}

function evaluateAcceptedItem(item, { source }) {
  const thing = item.thing;
  const capability = item.capability;
  const value = item.action?.value;
  const domain = capability?.binding?.domain;

  if (PROTECTED_TYPES.has(thing?.type)) {
    return rejected("protected_device_type", `${thing.name} 属于保护设备类型，不能自动执行`);
  }

  if (capability?.policy?.risk !== "low" || capability?.policy?.confirmation !== "never") {
    return rejected("policy_requires_confirmation", `${thing.name} ${capability.name} 当前策略要求确认`);
  }

  if (source === "voice" && capability?.kind === "config") {
    return rejected("voice_config_blocked", "语音入口不允许执行配置能力");
  }

  if (LONG_RUNNING_TYPES.has(thing?.type) && value === true) {
    return rejected("long_running_appliance_requires_confirmation", `${thing.name} 是长耗时设备，启动前需要确认`);
  }

  const range = NUMERIC_RANGES[domain];
  if (typeof value === "number" && range && (value < range[0] || value > range[1])) {
    return rejected("value_out_of_policy_range", `${thing.name} ${capability.name} 的数值 ${value} 超出 ${range[0]}-${range[1]} 策略范围`);
  }

  return {
    ok: true,
    code: "allowed",
    message: "通过本地权限策略",
  };
}

function rejected(code, message) {
  return {
    ok: false,
    code,
    message,
  };
}
