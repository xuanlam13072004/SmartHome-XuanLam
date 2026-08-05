declare module '*/shared/validation' {
    export function validateValueAgainstSchema(
        value: any,
        schema: Record<string, any>,
        options?: { required?: boolean },
    ): { valid: boolean; error: string | null };
    export function validateObjectAgainstSchema(
        value: Record<string, unknown>,
        schemaMap: Record<string, Record<string, unknown>>,
    ): { valid: boolean; error: string | null };
}
