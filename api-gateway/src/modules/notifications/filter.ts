import { ObjectId } from 'mongodb';
import {
    NOTIFICATION_SEVERITIES,
    capabilityFilterFor,
} from '../../../../shared/notification-categories';

export interface VisibleDevice {
    mac: string;
    name: string;
    owner: boolean;
    /** Members see events from the moment they joined, never the owner's history before. */
    joined_at: Date;
}

/**
 * MongoDB filter for the notification center: warning/critical events of the
 * devices the user may see, minus muted categories, optionally before a
 * cursor or after the "seen" watermark. Null when the user sees no device.
 */
export function buildNotificationFilter(input: {
    devices: VisibleDevice[];
    muted: string[];
    /** Strictly after this item in "newest first" order; without id, everything older than `at`. */
    before?: { at: Date; id: ObjectId | null };
    after?: Date | null;
}): Record<string, unknown> | null {
    const owned = input.devices.filter(device => device.owner).map(device => device.mac);
    const scope: Record<string, unknown>[] = [];
    if (owned.length > 0) scope.push({ device_id: { $in: owned } });
    for (const device of input.devices.filter(item => !item.owner)) {
        scope.push({ device_id: device.mac, received_at: { $gte: device.joined_at } });
    }
    if (scope.length === 0) return null;

    const conditions: Record<string, unknown>[] = [
        scope.length === 1 ? scope[0] : { $or: scope },
        { severity: { $in: [...NOTIFICATION_SEVERITIES] } },
    ];
    const capability = capabilityFilterFor(input.muted);
    if (capability) conditions.push({ capability_id: capability });
    if (input.before?.id) {
        conditions.push({
            $or: [
                { received_at: { $lt: input.before.at } },
                { received_at: input.before.at, _id: { $lt: input.before.id } },
            ],
        });
    } else if (input.before) {
        conditions.push({ received_at: { $lt: input.before.at } });
    }
    if (input.after) conditions.push({ received_at: { $gt: input.after } });
    return { $and: conditions };
}
