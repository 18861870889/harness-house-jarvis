/**
 * Batch Action Expander
 *
 * Expands a single batch action (e.g. "关主卧所有灯") into individual
 * per-device actions by querying the HCM Control Graph.
 *
 * This is a pure local operation — no LLM, no API calls.
 * Latency: < 1ms for typical homes (< 100 devices).
 *
 * Planner draft format for batch:
 *   {
 *     "actions": [
 *       {
 *         "target": "主卧",        ← room name
 *         "capability": "power",
 *         "value": false,
 *         "batch_room": true       ← triggers batch expansion
 *       }
 *     ]
 *   }
 *
 * After expansion:
 *   {
 *     "actions": [
 *       { "target": "主卧床尾射灯", "capability": "power", "value": false },
 *       { "target": "主卧主灯", "capability": "power", "value": false },
 *       ...
 *     ]
 *   }
 */

import { getHcmControlGraph } from "./hcmControlGraph.js";
import { findExplicitRoomIds } from "./hcmControlGraph.js";

/**
 * Expand batch actions in a planner draft.
 * If no batch actions are present, returns the draft unchanged.
 *
 * @param {Object} draft - planner draft with possible batch actions
 * @param {Object} home - HCM home model
 * @param {string} input - original user input (for room name resolution)
 * @returns {Object} draft with batch actions expanded
 */
export function expandBatchActions(draft, home, input = "") {
  if (!draft?.actions?.length) return draft;

  const hasBatch = draft.actions.some((a) => a?.batch_room || a?.batchRoom);
  if (!hasBatch) return draft;

  const graph = getHcmControlGraph(home);
  const expandedActions = [];

  for (const action of draft.actions) {
    if (!action?.batch_room && !action?.batchRoom) {
      expandedActions.push(action);
      continue;
    }

    // Resolve room name → spaceId
    const roomName = action.target || action.room || "";
    const roomIds = resolveRoomIds(roomName, input, home);

    if (roomIds.length === 0) {
      // Can't resolve room — pass through as-is, let safety gate handle it
      expandedActions.push(action);
      continue;
    }

    // Find all executable assets in the target room(s)
    // mappingStatus: "confirmed" (overlay-confirmed) or "inferred" (auto-detected)
    const roomAssets = graph.assets.filter(
      (asset) =>
        roomIds.includes(asset.spaceId) &&
        (asset.mappingStatus === "inferred" || asset.mappingStatus === "confirmed") &&
        asset.primaryEndpointId,
    );

    if (roomAssets.length === 0) {
      // No assets found — pass through as-is
      expandedActions.push(action);
      continue;
    }

    // Generate one action per asset
    for (const asset of roomAssets) {
      expandedActions.push({
        ...action,
        target: asset.name,
        device_id: asset.id,
        room_id: asset.spaceId,
        batch_room: undefined,
        batchRoom: undefined,
      });
    }
  }

  return {
    ...draft,
    actions: expandedActions,
    _batch_expanded: true,
    _batch_original_count: draft.actions.length,
    _batch_expanded_count: expandedActions.length,
  };
}

/**
 * Resolve a room name to spaceId(s).
 * Tries: direct name match → aliases → input text room patterns.
 */
function resolveRoomIds(roomName, input, home) {
  // 1. Direct match against space names/aliases
  const normalized = roomName.trim();
  const direct = (home?.spaces ?? [])
    .filter((space) => {
      const labels = [space.name, space.id, ...(space.aliases ?? [])].filter(Boolean);
      return labels.some((label) => label === normalized || label.includes(normalized) || normalized.includes(label));
    })
    .map((space) => space.id);

  if (direct.length > 0) return Array.from(new Set(direct));

  // 2. Use findExplicitRoomIds on the room name + input
  const fromInput = findExplicitRoomIds(`${roomName} ${input}`, home);
  if (fromInput.length > 0) return fromInput;

  return [];
}
