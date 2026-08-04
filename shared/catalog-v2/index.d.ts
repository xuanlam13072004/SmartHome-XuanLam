export type Availability = 'active' | 'planned';
export type PropertyChannel = 'reported' | 'desired' | 'diagnostic';
export type OperationRisk = 'normal' | 'sensitive' | 'dangerous';
export type ContractMaturity = 'draft' | 'edge_reviewed' | 'approved';

export interface CatalogIssue {
    code: string;
    path: string;
    message: string;
}

export interface CatalogV2 {
    catalog_schema: 'smarthome.catalog.v2';
    schema_version: 2;
    catalog_revision: number;
    lifecycle: 'draft' | 'published' | 'deprecated';
    capabilities: Array<Record<string, unknown>>;
    products: Array<Record<string, unknown>>;
}

export interface CompiledProductV2 {
    schema: 'compiled.product.v2';
    schema_version: 2;
    product_id: string;
    catalog_revision: number;
    contract_maturity: ContractMaturity;
    capability_instances: Array<Record<string, unknown>>;
    planned_capability_instances: Array<Record<string, unknown>>;
    firmware_default_state: Record<string, unknown>;
    reported_state_seed_policy: 'device_report_only';
    property_schemas: Record<string, Record<string, unknown>>;
    operations: Record<string, Record<string, unknown>>;
    events: Record<string, Record<string, unknown>>;
    resources: Record<string, Record<string, unknown>>;
    permissions: string[];
}

export function loadCatalogV2(baseDir?: string): CatalogV2;
export function lintCatalog(catalog: CatalogV2): { errors: CatalogIssue[]; warnings: CatalogIssue[] };
export function assertCatalogValid(catalog: CatalogV2): { errors: CatalogIssue[]; warnings: CatalogIssue[] };
export function compileCatalog(catalog: CatalogV2): {
    catalog_schema: 'smarthome.compiled-catalog.v2';
    schema_version: 2;
    catalog_revision: number;
    products: CompiledProductV2[];
    product_index: Record<string, CompiledProductV2>;
};
