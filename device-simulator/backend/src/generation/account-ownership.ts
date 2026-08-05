export interface GeneratedAccountIdentity {
    email: string;
    full_name: string;
    registry_created_at: Date;
}

export interface ExistingAccountIdentity {
    id: string;
    email: string;
    full_name: string | null;
    created_at: Date;
}

export interface AuthenticatedAccountIdentity {
    id: string;
    email: string;
}

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

/**
 * A matching account may only be adopted after a successful login and /auth/me
 * check prove that it is the account created for this exact registry identity.
 */
export const verifyRecoverableGeneratedAccount = (
    generated: GeneratedAccountIdentity,
    existing: ExistingAccountIdentity,
    authenticated: AuthenticatedAccountIdentity,
): string => {
    const identityMatches = normalizeEmail(existing.email) === normalizeEmail(generated.email)
        && (existing.full_name || '') === generated.full_name;
    if (!identityMatches) {
        throw new Error('ACCOUNT_IDENTITY_COLLISION: existing account does not match generated identity');
    }

    if (
        authenticated.id !== existing.id
        || normalizeEmail(authenticated.email) !== normalizeEmail(generated.email)
    ) {
        throw new Error('ACCOUNT_IDENTITY_COLLISION: authenticated account does not match database identity');
    }

    // The registry record is written before registration. A small tolerance
    // covers database/application clock skew without accepting an older user.
    const earliestAllowedCreation = generated.registry_created_at.getTime() - 5_000;
    if (existing.created_at.getTime() < earliestAllowedCreation) {
        throw new Error('ACCOUNT_IDENTITY_COLLISION: existing account predates simulator registry identity');
    }

    return existing.id;
};
