export type NotificationCategory = 'safety' | 'security' | 'camera' | 'outdoor' | 'device';
export declare const NOTIFICATION_CATEGORIES: readonly NotificationCategory[];
export declare const MUTABLE_NOTIFICATION_CATEGORIES: readonly NotificationCategory[];
export declare const NOTIFICATION_SEVERITIES: readonly ('warning' | 'critical')[];
export declare const CAPABILITY_CATEGORY: Readonly<Record<string, NotificationCategory>>;
export declare function notificationCategory(capabilityId: string): NotificationCategory;
export declare function capabilityFilterFor(
    mutedCategories: readonly string[],
): { $in: string[] } | { $nin: string[] } | null;
