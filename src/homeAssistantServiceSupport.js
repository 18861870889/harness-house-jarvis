export const MEDIA_FEATURES = {
  PAUSE: 1,
  TURN_ON: 128,
  TURN_OFF: 256,
  STOP: 4096,
  PLAY: 16384,
  VOLUME_SET: 4,
  VOLUME_MUTE: 8,
  VOLUME_STEP: 1024,
};

export const DOMAIN_SERVICES = {
  light: new Set(["turn_on", "turn_off"]),
  switch: new Set(["turn_on", "turn_off"]),
  fan: new Set(["turn_on", "turn_off", "set_percentage", "oscillate"]),
  cover: new Set(["open_cover", "close_cover", "set_cover_position", "stop_cover"]),
  climate: new Set(["turn_on", "turn_off", "set_temperature"]),
  button: new Set(["press"]),
  vacuum: new Set(["start", "stop", "return_to_base"]),
};

export function isHomeAssistantServiceSupported(serviceCall, capability) {
  const { domain, service } = serviceCall;
  if (domain === "media_player") return isMediaPlayerServiceSupported(service, capability);
  if (DOMAIN_SERVICES[domain]?.has(service)) return { ok: true };
  return {
    ok: false,
    code: "unsupported_service",
    message: `${domain}.${service} is not supported by Harness HA simulator`,
  };
}

export function mediaPlayerServiceForBoolean(value, capability) {
  if (value === false) {
    if (hasMediaFeature(capability, MEDIA_FEATURES.PAUSE)) return "media_pause";
    if (hasMediaFeature(capability, MEDIA_FEATURES.STOP)) return "media_stop";
    if (hasMediaFeature(capability, MEDIA_FEATURES.TURN_OFF)) return "turn_off";
    return "media_pause";
  }
  if (hasMediaFeature(capability, MEDIA_FEATURES.PLAY)) return "media_play";
  if (hasMediaFeature(capability, MEDIA_FEATURES.TURN_ON)) return "turn_on";
  return "turn_on";
}

function isMediaPlayerServiceSupported(service, capability) {
  const features = capability?.binding?.supportedFeatures;
  if (typeof features !== "number") return { ok: true, assumed: true };
  const featureByService = {
    media_pause: MEDIA_FEATURES.PAUSE,
    media_stop: MEDIA_FEATURES.STOP,
    media_play: MEDIA_FEATURES.PLAY,
    turn_on: MEDIA_FEATURES.TURN_ON,
    turn_off: MEDIA_FEATURES.TURN_OFF,
    volume_set: MEDIA_FEATURES.VOLUME_SET,
    volume_mute: MEDIA_FEATURES.VOLUME_MUTE,
    volume_up: MEDIA_FEATURES.VOLUME_STEP,
    volume_down: MEDIA_FEATURES.VOLUME_STEP,
  };
  const required = featureByService[service];
  if (!required) {
    return {
      ok: false,
      code: "unsupported_media_service",
      message: `media_player.${service} is not modeled by Harness HA simulator`,
    };
  }
  if ((features & required) === required) return { ok: true };
  return {
    ok: false,
    code: "unsupported_media_feature",
    message: `media_player.${service} is not supported by supported_features=${features}`,
  };
}

function hasMediaFeature(capability, feature) {
  const features = capability?.binding?.supportedFeatures;
  if (typeof features !== "number") return false;
  return (features & feature) === feature;
}
