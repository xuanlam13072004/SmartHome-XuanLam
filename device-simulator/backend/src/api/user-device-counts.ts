import type { Db } from 'mongodb';

export async function withDeviceCounts<T extends { account_id?: string; run_id: string }>(db: Db, users: T[]) {
    const filters = users.filter(user => user.account_id).map(user => ({
        run_id: user.run_id, simulator_user_id: user.account_id,
    }));
    const counts = filters.length ? await db.collection('simulated_devices').aggregate<{
        _id: { run: string; user: string }; created: number; claimed: number;
    }>([
        { $match: { $or: filters } },
        { $group: {
            _id: { run: '$run_id', user: '$simulator_user_id' },
            created: { $sum: 1 },
            claimed: { $sum: { $cond: [{ $eq: ['$provisioning_state', 'claimed'] }, 1, 0] } },
        } },
    ]).toArray() : [];
    const byUser = new Map(counts.map(count => [JSON.stringify([count._id.run, count._id.user]), count]));
    return users.map(user => {
        const count = byUser.get(JSON.stringify([user.run_id, user.account_id]));
        return { ...user, created_device_count: count?.created ?? 0, claimed_device_count: count?.claimed ?? 0 };
    });
}
