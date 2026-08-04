'use strict';

const { COLLECTIONS } = require('./collections');

async function collectionExists(db, name) {
    return Boolean(await db.listCollections({ name }, { nameOnly: true }).next());
}

async function ensureCollection(db, definition) {
    if (!(await collectionExists(db, definition.name))) {
        await db.createCollection(definition.name, definition.options);
    } else if (definition.options.validator) {
        await db.command({
            collMod: definition.name,
            validator: definition.options.validator,
            validationLevel: definition.options.validationLevel,
            validationAction: definition.options.validationAction,
        });
    }

    const collection = db.collection(definition.name);
    for (const index of definition.indexes) {
        await collection.createIndex(index.key, index.options);
    }
}

async function applyMongoCollectionsV2(db) {
    for (const definition of COLLECTIONS) await ensureCollection(db, definition);
}

async function main() {
    if (process.env.ALLOW_V2_DATABASE_INITIALIZATION !== 'true') {
        throw new Error('Refusing to initialize MongoDB V2 without ALLOW_V2_DATABASE_INITIALIZATION=true.');
    }

    const uri = process.env.MONGO_URI;
    const dbName = process.env.MONGO_DB_NAME;
    if (!uri || !dbName) throw new Error('MONGO_URI and MONGO_DB_NAME are required.');

    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri);
    await client.connect();
    try {
        const db = client.db(dbName);
        await applyMongoCollectionsV2(db);
        process.stdout.write(`MongoDB V2 collections initialized in ${dbName}.\n`);
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
    applyMongoCollectionsV2,
    ensureCollection,
};
