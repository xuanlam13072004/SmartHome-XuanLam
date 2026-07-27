import type { SimulationRunConfig } from '../domain/simulation-run';

export interface WorkloadLimits {
    maxUsersPerRun: number;
    maxDevicesPerRun: number;
    maxActiveDevices: number;
    maxTelemetryMessagesPerSecond: number;
}

export interface WorkloadEstimate {
    maximum_devices: number;
    maximum_online_devices: number;
    projected_telemetry_per_second: number;
    expected_online_devices: number;
    expected_telemetry_per_second: number;
}

export interface WorkloadBudgetResult {
    accepted: boolean;
    estimate: WorkloadEstimate;
    violations: string[];
}

export const evaluateWorkloadBudget = (
    config: Pick<
        SimulationRunConfig,
        | 'user_count'
        | 'devices_max'
        | 'initial_offline_rate'
        | 'telemetry_interval'
        | 'auto_start'
    >,
    limits: WorkloadLimits,
): WorkloadBudgetResult => {
    const maximumDevices = config.user_count * config.devices_max;
    const expectedOnlineDevices = config.auto_start
        ? Math.ceil(maximumDevices * (1 - config.initial_offline_rate / 100))
        : 0;
    const maximumOnlineDevices = config.auto_start && config.initial_offline_rate < 100
        ? maximumDevices
        : 0;
    const projectedTelemetryPerSecond = config.telemetry_interval > 0
        ? maximumOnlineDevices / config.telemetry_interval
        : Number.POSITIVE_INFINITY;
    const expectedTelemetryPerSecond = config.telemetry_interval > 0
        ? expectedOnlineDevices / config.telemetry_interval
        : Number.POSITIVE_INFINITY;
    const violations: string[] = [];

    if (config.user_count > limits.maxUsersPerRun) {
        violations.push(
            `User count exceeds MAX_USERS_PER_RUN (${limits.maxUsersPerRun})`,
        );
    }
    if (maximumDevices > limits.maxDevicesPerRun) {
        violations.push(
            `Worst-case device count exceeds MAX_DEVICES_PER_RUN (${limits.maxDevicesPerRun})`,
        );
    }
    if (maximumOnlineDevices > limits.maxActiveDevices) {
        violations.push(
            `Worst-case online device count exceeds MAX_ACTIVE_DEVICES (${limits.maxActiveDevices})`,
        );
    }
    if (projectedTelemetryPerSecond > limits.maxTelemetryMessagesPerSecond) {
        violations.push(
            `Projected telemetry rate exceeds MAX_TELEMETRY_MESSAGES_PER_SECOND (${limits.maxTelemetryMessagesPerSecond})`,
        );
    }

    return {
        accepted: violations.length === 0,
        estimate: {
            maximum_devices: maximumDevices,
            maximum_online_devices: maximumOnlineDevices,
            projected_telemetry_per_second:
                Math.round(projectedTelemetryPerSecond * 100) / 100,
            expected_online_devices: expectedOnlineDevices,
            expected_telemetry_per_second:
                Math.round(expectedTelemetryPerSecond * 100) / 100,
        },
        violations,
    };
};
