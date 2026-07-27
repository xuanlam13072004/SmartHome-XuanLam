export const startupDelayMs = (
    startupRampMs: number,
    intervalMs: number,
    randomValue: number = Math.random(),
): number => {
    const spread = startupRampMs > 0 ? startupRampMs : intervalMs;
    return Math.max(0, Math.floor(clampUnit(randomValue) * spread));
};

export const nextTelemetryDelayMs = (
    intervalMs: number,
    jitterPercent: number,
    randomValue: number = Math.random(),
): number => {
    const normalizedJitter = Math.min(Math.max(jitterPercent, 0), 50) / 100;
    const factor = 1 + ((clampUnit(randomValue) * 2) - 1) * normalizedJitter;
    return Math.max(1000, Math.round(intervalMs * factor));
};

const clampUnit = (value: number): number => Math.min(Math.max(value, 0), 1);
