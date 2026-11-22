/**
 * The model's values, parsed against an operation's input schema; never
 * guessed or clamped ("10" for a 30–3600 s field is refused).
 */

export type Parsed = { ok: true; value: unknown } | { ok: false; reason: 'bad_value' | 'missing_value' };

export const TRUE = new Set(['true', '1', 'bật', 'có', 'on', 'yes']);
export const FALSE = new Set(['false', '0', 'tắt', 'không', 'off', 'no']);

/** The model's `value` (a string) as the operation's input; never guessed. */
export function parseValue(schema: Record<string, any>, raw: unknown): Parsed {
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    if (text === '') {
        return schema.default !== undefined ? { ok: true, value: schema.default } : { ok: false, reason: 'missing_value' };
    }
    if (schema.type === 'integer' || schema.type === 'number') {
        const value = Number(text.replace(',', '.'));
        if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
            return { ok: false, reason: 'bad_value' };
        }
        if ((typeof schema.minimum === 'number' && value < schema.minimum)
            || (typeof schema.maximum === 'number' && value > schema.maximum)
            || (Array.isArray(schema.enum) && !schema.enum.includes(value))) {
            return { ok: false, reason: 'bad_value' };
        }
        return { ok: true, value };
    }
    if (schema.type === 'boolean') {
        const lower = text.toLowerCase();
        if (TRUE.has(lower)) return { ok: true, value: true };
        if (FALSE.has(lower)) return { ok: true, value: false };
        return { ok: false, reason: 'bad_value' };
    }
    const choice = (schema.enum as string[] | undefined)?.find(item => item.toLowerCase() === text.toLowerCase());
    return choice === undefined ? { ok: false, reason: 'bad_value' } : { ok: true, value: choice };
}
