'use strict';

const { compileCatalog } = require('./compiler');
const { loadCatalogV2 } = require('./loader');

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) deepFreeze(nested);
    return Object.freeze(value);
}

class RuntimeCatalog {
    constructor(options = {}) {
        this.baseDir = options.baseDir;
        this.log = options.log || console;
        this.catalog = null;
    }

    async start() {
        const source = loadCatalogV2(this.baseDir);
        if (source.lifecycle !== 'published') {
            throw new Error(`Runtime catalog must be published, received '${source.lifecycle}'`);
        }
        const compiled = compileCatalog(source);
        const nonPublished = compiled.products
            .filter(product => product.lifecycle !== 'published')
            .map(product => product.product_id);
        if (nonPublished.length > 0) {
            throw new Error(`Runtime catalog contains non-published products: ${nonPublished.join(', ')}`);
        }
        this.catalog = deepFreeze(compiled);
        this.log.info?.(
            {
                catalog_revision: compiled.catalog_revision,
                product_count: compiled.products.length,
            },
            'Published Product Catalog loaded',
        );
        return this;
    }

    get catalogVersion() {
        return this.catalog?.catalog_revision || 0;
    }

    getAllProducts() {
        this.assertStarted();
        return this.catalog.products;
    }

    getProduct(productId) {
        this.assertStarted();
        return this.catalog.product_index[productId] || null;
    }

    getOperation(productId, instanceId, operationName) {
        const product = this.getProduct(productId);
        if (!product) return null;
        return product.operations[`${instanceId}.${operationName}`] || null;
    }

    getResource(productId, instanceId, resourceId) {
        const product = this.getProduct(productId);
        if (!product) return null;
        return product.resources[`${instanceId}.${resourceId}`] || null;
    }

    getCredential(productId, instanceId, credentialId) {
        const product = this.getProduct(productId);
        if (!product) return null;
        return product.credentials[`${instanceId}.${credentialId}`] || null;
    }

    assertStarted() {
        if (!this.catalog) throw new Error('Runtime Product Catalog has not started');
    }
}

module.exports = { RuntimeCatalog };
