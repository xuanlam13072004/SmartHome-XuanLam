import { env } from '../config/env';

export interface ValueValidation {
    min?: number;
    max?: number;
    enum?: unknown[];
    required?: boolean;
    max_length?: number;
}

export interface StateProperty {
    value_type: 'number' | 'boolean' | 'string' | string;
    validation?: ValueValidation;
}

export interface CapabilityCommandArgument {
    name: string;
    value_type?: string;
    validation?: ValueValidation;
}

export interface CapabilityCommand {
    action: string;
    arguments: CapabilityCommandArgument[];
}

export interface CapabilityInstance {
    capability_id: string;
    instance: string;
    value_type?: string;
    validation?: ValueValidation;
    state_properties: Record<string, StateProperty>;
    diagnostic_properties: Record<string, StateProperty>;
    commands: CapabilityCommand[];
}

export interface ProductCatalog {
    id: string;
    display_name: string;
    category: string;
    capabilities: any[];
    capabilityInstances: CapabilityInstance[];
    default_state: Record<string, unknown>;
}

let cachedProducts: ProductCatalog[] = [];

interface RawCapabilityCommand extends Omit<CapabilityCommand, 'arguments'> {
    arguments?: Array<string | CapabilityCommandArgument>;
}

interface RawCapabilityInstance extends Omit<CapabilityInstance, 'commands'> {
    commands?: RawCapabilityCommand[];
}

interface RawProductCatalog extends Omit<ProductCatalog, 'id' | 'capabilityInstances'> {
    id?: string;
    _id?: string;
    capabilityInstances?: RawCapabilityInstance[];
}

const normalizeCapabilityInstance = (
    instance: RawCapabilityInstance,
): CapabilityInstance => ({
    ...instance,
    state_properties: instance.state_properties || {},
    diagnostic_properties: instance.diagnostic_properties || {},
    commands: (instance.commands || []).map((command) => ({
        action: command.action,
        arguments: (command.arguments || []).map((argument) =>
            typeof argument === 'string'
                ? {
                    name: argument,
                    value_type: instance.value_type,
                    validation: instance.validation,
                }
                : argument,
        ),
    })),
});

const normalizeProduct = (rawProduct: RawProductCatalog): ProductCatalog => {
    const id = rawProduct.id || rawProduct._id;
    if (!id) {
        throw new Error('Product catalog entry has no id or _id');
    }
    if (!Array.isArray(rawProduct.capabilityInstances)) {
        throw new Error(`Product catalog entry ${id} has no capabilityInstances`);
    }
    return {
        ...rawProduct,
        id,
        capabilityInstances: rawProduct.capabilityInstances.map(normalizeCapabilityInstance),
    };
};

export const loadCatalog = async (): Promise<ProductCatalog[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.API_REQUEST_TIMEOUT_MS);
    try {
        const url = `${env.API_GATEWAY_URL.replace(/\/$/, '')}/products`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Catalog request failed with HTTP ${response.status}`);
        }

        const data = await response.json() as {
            success?: boolean;
            products?: RawProductCatalog[];
        };
        if (!data.success || !Array.isArray(data.products) || data.products.length === 0) {
            throw new Error('API Gateway returned an empty or invalid product catalog');
        }

        cachedProducts = data.products.map(normalizeProduct);
        return cachedProducts;
    } finally {
        clearTimeout(timer);
    }
};

export const getCachedCatalog = (): ProductCatalog[] => {
    return cachedProducts;
};

export const getProduct = (productId: string): ProductCatalog => {
    const product = cachedProducts.find((item) => item.id === productId);
    if (!product) {
        throw new Error(`Product ${productId} is not available in the API Gateway catalog`);
    }
    return product;
};
