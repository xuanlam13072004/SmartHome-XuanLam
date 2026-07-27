import type { RunStatus } from '../domain/simulation-run';

const blockedRuntimeRecoveryStatuses = new Set<RunStatus>([
    'paused',
    'cleaning',
    'cleaned',
    'cleanup_blocked',
]);

export const shouldRestoreRunRuntime = (status: RunStatus): boolean =>
    !blockedRuntimeRecoveryStatuses.has(status);
