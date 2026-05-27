export const ALLOWED_ROLES = ['smart_plug', 'rgb_light', 'switch_2_gang'] as const;

export type DeviceRole = typeof ALLOWED_ROLES[number];

export function isAllowedRole(role: string): role is DeviceRole {
    return ALLOWED_ROLES.includes(role as DeviceRole);
}
