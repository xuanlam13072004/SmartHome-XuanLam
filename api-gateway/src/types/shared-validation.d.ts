declare module '*/shared/validation' {
    export function validateValueAgainstSchema(
        value: any,
        schema: {
            value_type: string;
            validation?: {
                required?: boolean;
                min?: number;
                max?: number;
                max_length?: number;
                enum?: any[];
            };
            validation_versions?: Record<string | number, {
                required?: boolean;
                min?: number;
                max?: number;
                max_length?: number;
                enum?: any[];
            }>;
            validation_ref?: string;
        },
        schemaVersion?: string | number
    ): { valid: boolean; error: string | null };
}
