'use strict';

/**
 * Device events of severity warning/critical become notifications. Each is
 * filed under a category by the capability that raised it; users may mute
 * any category except "safety" (fire, gas, smoke, siren).
 */
const NOTIFICATION_CATEGORIES = Object.freeze(['safety', 'security', 'camera', 'outdoor', 'device']);
const MUTABLE_NOTIFICATION_CATEGORIES = Object.freeze(['security', 'camera', 'outdoor', 'device']);
const NOTIFICATION_SEVERITIES = Object.freeze(['warning', 'critical']);

const CAPABILITY_CATEGORY = Object.freeze({
    gas_measurement: 'safety',
    smoke_measurement: 'safety',
    flame_detection: 'safety',
    hazard_controller: 'safety',
    alarm_siren: 'safety',
    door_lock: 'security',
    door_position: 'security',
    pin_authentication: 'security',
    keypad_input: 'security',
    camera_stream: 'camera',
    video_recording: 'camera',
    cover_controller: 'outdoor',
    rain_detection: 'outdoor',
    roof_policy: 'outdoor',
    soil_moisture_measurement: 'outdoor',
    water_level_measurement: 'outdoor',
    irrigation_pump: 'outdoor',
    irrigation_policy: 'outdoor',
});

function notificationCategory(capabilityId) {
    return CAPABILITY_CATEGORY[capabilityId] || 'device';
}

/**
 * MongoDB condition on `capability_id` that leaves out muted categories, or
 * null when nothing is muted. "device" covers every unlisted capability, so
 * muting it switches to an allow-list of the listed, unmuted ones.
 */
function capabilityFilterFor(mutedCategories) {
    const muted = new Set((mutedCategories || []).filter(category => category !== 'safety'));
    if (muted.size === 0) return null;
    const entries = Object.entries(CAPABILITY_CATEGORY);
    if (muted.has('device')) {
        return { $in: entries.filter(([, category]) => !muted.has(category)).map(([capability]) => capability) };
    }
    return { $nin: entries.filter(([, category]) => muted.has(category)).map(([capability]) => capability) };
}

module.exports = {
    CAPABILITY_CATEGORY,
    MUTABLE_NOTIFICATION_CATEGORIES,
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_SEVERITIES,
    capabilityFilterFor,
    notificationCategory,
};
