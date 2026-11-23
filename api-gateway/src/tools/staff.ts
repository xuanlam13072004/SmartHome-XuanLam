/**
 * The Admin Console's root (docs/architecture/admin.md), inside the Gateway container:
 *
 *   docker compose exec api-gateway node dist/tools/staff.js create-root <email> "<Họ tên>"
 *   docker compose exec api-gateway node dist/tools/staff.js reset-root
 *   docker compose exec api-gateway node dist/tools/staff.js list
 *
 * create-root makes the one root and prints a temporary password, changed at
 * the first sign-in; reset-root prints a new one (forgotten password or a
 * lock) and signs the root out everywhere. Other staff are managed by the
 * root in the Console ("Nhân viên"), never here.
 */
import { Pool } from 'pg';
import { env } from '../config/env';
import { createRootStaff, resetRootStaff } from '../modules/admin/staff';

async function main() {
    const [command, email, ...name] = process.argv.slice(2);
    const pg = new Pool({
        host: env.PG_HOST, port: env.PG_PORT, database: env.PG_DATABASE, user: env.PG_USER, password: env.PG_PASSWORD,
        ssl: env.PG_SSL ? { rejectUnauthorized: false } : false, max: 2,
    });
    try {
        if (command === 'create-root' && email) {
            const result = await createRootStaff(pg, { email, full_name: name.join(' ') || 'Admin gốc' });
            console.log(`Admin gốc ${email.trim().toLowerCase()} đã được tạo.`);
            console.log(`Mật khẩu tạm (chỉ hiện một lần, đổi ngay ở lần đăng nhập đầu): ${result.temporary_password}`);
        } else if (command === 'reset-root') {
            const result = await resetRootStaff(pg);
            console.log(`Đã đặt lại mật khẩu cho admin gốc ${result.email}; mọi phiên của admin gốc đã kết thúc.`);
            console.log(`Mật khẩu tạm (chỉ hiện một lần): ${result.temporary_password}`);
        } else if (command === 'list') {
            const staff = await pg.query(
                `SELECT email, full_name, is_root, status, array_length(permissions, 1) AS permissions, last_login_at
                 FROM staff_accounts ORDER BY is_root DESC, created_at`,
            );
            console.table(staff.rows);
        } else {
            console.log('Usage: staff.js create-root <email> [họ tên] | reset-root | list');
            process.exitCode = 1;
        }
    } finally {
        await pg.end();
    }
}

main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
});
