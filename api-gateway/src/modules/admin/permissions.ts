/**
 * What a staff member of the Admin Console may do (docs/architecture/admin.md).
 * The root has everything, including managing staff; the others get what the
 * root ticks. A "manage" permission includes the matching "view".
 */
export const STAFF_PERMISSIONS = [
    { code: 'overview.view', group: 'Tổng quan', label: 'Xem số liệu và biểu đồ' },
    { code: 'accounts.view', group: 'Tài khoản khách', label: 'Tìm và xem chi tiết tài khoản' },
    { code: 'accounts.manage', group: 'Tài khoản khách', label: 'Khóa/mở khóa, đăng xuất mọi thiết bị', implies: ['accounts.view'] },
    { code: 'payments.view', group: 'Thanh toán', label: 'Xem đơn hàng và tiền chưa khớp' },
    { code: 'payments.manage', group: 'Thanh toán', label: 'Xác nhận tiền, hủy đơn', implies: ['payments.view'] },
    { code: 'plans.gift', group: 'Gói', label: 'Tặng/gia hạn gói', implies: ['accounts.view'] },
    { code: 'assistant.view', group: 'Trợ lý', label: 'Xem thống kê trợ lý' },
    { code: 'audit.view', group: 'Nhật ký', label: 'Xem nhật ký quản trị' },
    { code: 'simulator.view', group: 'Simulator', label: 'Xem lần chạy, thiết bị ảo, người dùng ảo' },
    {
        code: 'simulator.manage', group: 'Simulator',
        label: 'Kiểm thử tải, đo độ trễ, điều khiển thiết bị ảo, xưởng sản xuất', implies: ['simulator.view'],
    },
] as const;

export type StaffPermission = typeof STAFF_PERMISSIONS[number]['code'];

/** Only the root: creating, changing and locking staff. Never granted. */
export const ROOT_ONLY = 'staff.manage';
export type RequiredPermission = StaffPermission | typeof ROOT_ONLY;

export const PERMISSION_CODES = STAFF_PERMISSIONS.map(item => item.code) as StaffPermission[];

export const STAFF_PRESETS = [
    { code: 'support', name: 'Hỗ trợ khách hàng', permissions: ['accounts.manage', 'audit.view'] },
    { code: 'accounting', name: 'Kế toán', permissions: ['overview.view', 'payments.manage', 'plans.gift'] },
    { code: 'engineering', name: 'Kỹ thuật', permissions: ['overview.view', 'simulator.manage'] },
] as const satisfies ReadonlyArray<{ code: string; name: string; permissions: readonly StaffPermission[] }>;

/** The granted codes plus what they include, in catalog order, unknown codes dropped. */
export function expandPermissions(codes: readonly string[]): StaffPermission[] {
    const granted = new Set<string>();
    for (const code of codes) {
        const item = STAFF_PERMISSIONS.find(permission => permission.code === code);
        if (!item) continue;
        granted.add(item.code);
        for (const implied of (item as { implies?: readonly string[] }).implies ?? []) granted.add(implied);
    }
    return PERMISSION_CODES.filter(code => granted.has(code));
}

export interface StaffIdentity {
    id: string;
    email: string;
    full_name: string;
    is_root: boolean;
    permissions: StaffPermission[];
}

export function staffCan(staff: Pick<StaffIdentity, 'is_root' | 'permissions'>, permission: RequiredPermission): boolean {
    if (staff.is_root) return true;
    if (permission === ROOT_ONLY) return false;
    return staff.permissions.includes(permission);
}
