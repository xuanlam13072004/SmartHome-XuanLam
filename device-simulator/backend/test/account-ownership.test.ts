import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAccountCleanupTargets } from '../src/cleanup/targets';
import { verifyRecoverableGeneratedAccount } from '../src/generation/account-ownership';

const registryCreatedAt = new Date('2026-07-27T00:00:00.000Z');
const generated = {
    username: 'sim_run_0_abcd',
    email: 'sim_run_0_abcd@simulator.local',
    full_name: 'Simulated User run-0',
    registry_created_at: registryCreatedAt,
};
const existing = {
    id: '34c06b40-bc4f-493d-bcc9-afbaf44128e8',
    username: generated.username,
    email: generated.email,
    full_name: generated.full_name,
    created_at: new Date(registryCreatedAt.getTime() + 500),
};
const authenticated = {
    id: existing.id,
    email: generated.email,
};

test('a matching authenticated account can recover an interrupted registration', () => {
    assert.equal(
        verifyRecoverableGeneratedAccount(generated, existing, authenticated),
        existing.id,
    );
});

test('an account with a colliding username or email is never adopted', () => {
    assert.throws(
        () => verifyRecoverableGeneratedAccount(
            generated,
            { ...existing, username: 'manual-user' },
            authenticated,
        ),
        /ACCOUNT_IDENTITY_COLLISION/,
    );
});

test('authentication must resolve to the same database account', () => {
    assert.throws(
        () => verifyRecoverableGeneratedAccount(
            generated,
            existing,
            { ...authenticated, id: '17735cc8-9f03-4c87-9241-84caf1f699eb' },
        ),
        /ACCOUNT_IDENTITY_COLLISION/,
    );
});

test('an older manual account cannot be treated as interrupted registration', () => {
    assert.throws(
        () => verifyRecoverableGeneratedAccount(
            generated,
            {
                ...existing,
                created_at: new Date(registryCreatedAt.getTime() - 60_000),
            },
            authenticated,
        ),
        /predates simulator registry identity/,
    );
});

test('cleanup targets include only accounts with explicit simulator ownership', () => {
    assert.deepEqual(
        classifyAccountCleanupTargets([
            {
                account_id: 'simulator-account',
                account_created_by_simulator: true,
            },
            {
                account_id: 'manual-or-legacy-account',
            },
            {
                account_id: 'explicitly-unverified-account',
                account_created_by_simulator: false,
            },
            {},
        ]),
        {
            ownedAccountIds: ['simulator-account'],
            unverifiedAccountIds: [
                'manual-or-legacy-account',
                'explicitly-unverified-account',
            ],
        },
    );
});
