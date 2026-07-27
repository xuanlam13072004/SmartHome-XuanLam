export interface AccountCleanupCandidate {
    account_id?: string;
    account_created_by_simulator?: boolean;
}

export interface AccountCleanupTargets {
    ownedAccountIds: string[];
    unverifiedAccountIds: string[];
}

export const classifyAccountCleanupTargets = (
    users: AccountCleanupCandidate[],
): AccountCleanupTargets => {
    const ownedAccountIds = new Set<string>();
    const unverifiedAccountIds = new Set<string>();

    for (const user of users) {
        if (!user.account_id) continue;
        if (user.account_created_by_simulator === true) {
            ownedAccountIds.add(user.account_id);
        } else {
            unverifiedAccountIds.add(user.account_id);
        }
    }

    return {
        ownedAccountIds: [...ownedAccountIds],
        unverifiedAccountIds: [...unverifiedAccountIds],
    };
};
