export function capabilityAccess(capability) {
  if (!["control", "action"].includes(capability?.kind)) return "read";
  const policy = capability.policy;
  if (policy?.risk === "low" && policy.autoExecutable && policy.confirmation === "never") {
    return capability.binding?.domain === "button" && /(?:投喂|喂食|出粮)(?:一次|执行|动作|按钮|$)/.test(capability.name) ? "confirm" : "execute";
  }
  if (["low", "medium"].includes(policy?.risk) && ["always", "sometimes"].includes(policy.confirmation)) return "confirm";
  return "blocked";
}

export function actionIsConfirmed(action, confirmedActions = []) {
  const id = action.device_id ?? action.thingId;
  const capability = action.capability ?? action.capabilityId;
  return confirmedActions.some(a => (a.device_id ?? a.thingId) === id && (a.capability ?? a.capabilityId) === capability
    && JSON.stringify(a.value) === JSON.stringify(action.value));
}
