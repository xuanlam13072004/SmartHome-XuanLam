import { Db } from 'mongodb';
import Redis from 'ioredis';

export interface CompiledCommandArg {
    name: string;
    value_type: string;
    validation?: Record<string, any>;
    validation_ref?: string;
}

export interface CompiledCommand {
    capability_id: string;
    instance: string;
    arguments: CompiledCommandArg[];
}

export interface CompiledProduct {
    _id: string;
    manufacturer: string;
    model_name: string;
    display_name: string;
    firmware_family: string;
    connectivity: string;
    category: string;
    icon: string;
    description: string;
    default_state: Record<string, any>;
    allowedStateKeys: Set<string>;
    allowedDiagnosticKeys: Set<string>;
    allowedCommandActions: Map<string, Map<string, CompiledCommand>>;
    catalogVersion: number;
}

export interface CatalogCacheOptions {
    onReloadSuccess?: () => void;
}

export class CatalogCache {
    catalogVersion: number;
    constructor(db: Db, redis: Redis, log: any, options?: CatalogCacheOptions);
    start(): Promise<void>;
    reload(): Promise<void>;
    getProduct(productId: string): CompiledProduct | undefined;
    getAllProducts(): CompiledProduct[];
    getCapability(capabilityId: string): any;
}
