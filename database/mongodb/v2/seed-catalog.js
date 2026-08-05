'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function resolveSharedCatalogModule() {
    const candidates = [
        path.resolve(__dirname, '../../../shared/catalog-v2'),
        path.resolve(__dirname, '../../../../shared/catalog-v2'),
    ];
    const found = candidates.find(candidate => fs.existsSync(path.join(candidate, 'index.js')));
    if (!found) throw new Error(`Unable to resolve shared/catalog-v2 from: ${candidates.join(', ')}`);
    return require(found);
}

const { assertCatalogValid, loadCatalogV2 } = resolveSharedCatalogModule();
const CATALOG_SOURCE_DIR = path.resolve(__dirname, '../../catalog-v2');

function digestCatalog(catalog) {
    return crypto.createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

async function seedCatalogV2(db, catalog = loadCatalogV2(CATALOG_SOURCE_DIR)) {
    assertCatalogValid(catalog);
    if (catalog.lifecycle === 'published' && process.env.ALLOW_CATALOG_PUBLISH !== 'true') {
        throw new Error('ALLOW_CATALOG_PUBLISH=true is required to seed a published catalog.');
    }

    const capabilityOperations = catalog.capabilities.map(capability => ({
        replaceOne: {
            filter: { capability_id: capability.capability_id, revision: capability.revision },
            replacement: {
                _id: `${capability.capability_id}@${capability.revision}`,
                ...capability,
            },
            upsert: true,
        },
    }));
    const productOperations = catalog.products.map(product => ({
        replaceOne: {
            filter: { product_id: product.product_id, catalog_revision: product.catalog_revision },
            replacement: {
                _id: `${product.product_id}@${product.catalog_revision}`,
                ...product,
            },
            upsert: true,
        },
    }));

    if (capabilityOperations.length > 0) {
        await db.collection('capability_definitions').bulkWrite(capabilityOperations, { ordered: false });
    }
    if (productOperations.length > 0) {
        await db.collection('product_definitions').bulkWrite(productOperations, { ordered: false });
    }

    await db.collection('catalog_releases').replaceOne(
        { catalog_revision: catalog.catalog_revision },
        {
            _id: `catalog@${catalog.catalog_revision}`,
            schema_version: catalog.schema_version,
            catalog_revision: catalog.catalog_revision,
            lifecycle: catalog.lifecycle,
            digest: digestCatalog(catalog),
            product_refs: catalog.products.map(product => `${product.product_id}@${product.catalog_revision}`),
            capability_refs: catalog.capabilities.map(capability => `${capability.capability_id}@${capability.revision}`),
            created_at: new Date(),
        },
        { upsert: true },
    );
}

async function main() {
    if (process.env.ALLOW_V2_DATABASE_INITIALIZATION !== 'true') {
        throw new Error('Refusing to seed Catalog V2 without ALLOW_V2_DATABASE_INITIALIZATION=true.');
    }

    const uri = process.env.MONGO_URI;
    const dbName = process.env.MONGO_DB_NAME;
    if (!uri || !dbName) throw new Error('MONGO_URI and MONGO_DB_NAME are required.');

    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri);
    await client.connect();
    try {
        await seedCatalogV2(client.db(dbName));
        process.stdout.write(`Published Product Catalog seeded in ${dbName}.\n`);
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    digestCatalog,
    seedCatalogV2,
};
