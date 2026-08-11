import { env } from '../config/env';

export interface ValueSchema {
    type: 'boolean' | 'number' | 'integer' | 'string' | 'array' | string;
    nullable?: boolean;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    min_length?: number;
    max_length?: number;
    min_items?: number;
    max_items?: number;
    items?: ValueSchema;
    default?: unknown;
    unit?: string;
    precision?: number;
    required?: boolean;
    channel?: 'reported' | 'desired' | 'diagnostic';
    id?: string;
    path?: string;
    presentation?: PresentationMetadata;
}

export interface PresentationMetadata {
    display_name?: string;
    label?: string;
    description?: string;
    icon?: string;
    section?: string;
    order?: number;
    ui_hint?: string;
    [key: string]: unknown;
}

export interface OperationEffect {
    type: string;
    property?: string;
    value?: unknown;
    value_from?: string;
}

export interface CapabilityOperation {
    id: string;
    input: Record<string, ValueSchema>;
    effects: OperationEffect[];
    permission: string;
    risk: 'normal' | 'sensitive' | 'dangerous';
    ack_policy?: {
        success_condition?: string;
        completion_signal?: string;
        reference?: string;
    };
    timeout_ms?: number;
    idempotent?: boolean;
    presentation?: PresentationMetadata;
}

export interface CapabilityProperty extends ValueSchema {
    id: string;
    channel: 'reported' | 'desired' | 'diagnostic';
    state_authority?: 'device_firmware' | 'backend_intent' | 'product_catalog';
    path: string;
}

export interface CapabilityInstance {
    instance_id: string;
    capability_id: string;
    properties: CapabilityProperty[];
    operations: CapabilityOperation[];
    events?: Array<{
        id: string;
        producer?: string;
        severity?: string;
        retention?: string;
        data?: Record<string, ValueSchema>;
        presentation?: PresentationMetadata;
    }>;
    resources?: Array<Record<string, unknown>>;
    credentials?: Array<Record<string, unknown>>;
    semantic_role?: string;
    presentation?: PresentationMetadata;
    runtime?: Record<string, unknown>;
}

export interface ProductCatalog {
    schema: 'compiled.product.v2';
    product_id: string;
    catalog_revision: number;
    model_name: string;
    category: string;
    description?: string;
    ui_profile?: string;
    ui_profile_version?: number;
    presentation: PresentationMetadata;
    capability_instances: CapabilityInstance[];
    local_policies?: Array<Record<string, unknown>>;
    firmware_default_state: DeviceStateSeed;
    firmware_compatibility?: { family?: string; [key: string]: unknown };
    operations: Record<string, CapabilityOperation & {
        instance_id: string;
        capability_id: string;
    }>;
}

export interface DeviceStateSeed {
    schema: 'device.state.v2';
    state_version: number;
    instances: Record<string, {
        reported: Record<string, unknown>;
        desired: Record<string, unknown>;
    }>;
    diagnostics: Record<string, Record<string, unknown>>;
}

let cachedProducts: ProductCatalog[] = [];
let catalogRevision = 0;

export const loadCatalog = async (): Promise<ProductCatalog[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.API_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(
            `${env.API_GATEWAY_URL.replace(/\/$/, '')}/products`,
            { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}`);
        const data = await response.json() as {
            success?: boolean;
            catalog_revision?: number;
            products?: ProductCatalog[];
        };
        if (!data.success || !Array.isArray(data.products) || data.products.length === 0) {
            throw new Error('API Gateway returned an empty Product Catalog');
        }
        if (!Number.isInteger(data.catalog_revision) || data.catalog_revision! < 1) {
            throw new Error('API Gateway returned an invalid Catalog revision');
        }
        for (const product of data.products) {
            if (
                product.schema !== 'compiled.product.v2'
                || !Number.isInteger(product.catalog_revision)
                || product.catalog_revision < 1
                || !Array.isArray(product.capability_instances)
            ) {
                throw new Error(`Product ${product.product_id || '<unknown>'} has an invalid compiled contract`);
            }
        }
        catalogRevision = data.catalog_revision!;
        cachedProducts = data.products;
        return cachedProducts;
    } finally {
        clearTimeout(timer);
    }
};

export const getCachedCatalog = (): ProductCatalog[] => cachedProducts;
export const getCatalogRevision = (): number => catalogRevision;

export class ProductContractUnavailableError extends Error {
    readonly code = 'PRODUCT_CONTRACT_UNAVAILABLE';

    constructor(
        readonly productId: string,
        readonly expectedRevision: number | undefined,
        readonly availableRevision: number | undefined,
    ) {
        super(expectedRevision === undefined
            ? `Product ${productId} is unavailable in the runtime Catalog`
            : `Product ${productId} revision ${expectedRevision} is unavailable; runtime Catalog provides revision ${availableRevision ?? 'none'}`);
        this.name = 'ProductContractUnavailableError';
    }
}

export const getProduct = (
    productId: string,
    expectedRevision?: number,
): ProductCatalog => {
    const product = cachedProducts.find(item => item.product_id === productId);
    if (!product || (
        expectedRevision !== undefined
        && product.catalog_revision !== expectedRevision
    )) {
        throw new ProductContractUnavailableError(
            productId,
            expectedRevision,
            product?.catalog_revision,
        );
    }
    return product;
};
