'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CATALOG_DIR = path.resolve(__dirname, '../../database/catalog-v2');

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        error.message = `Unable to read catalog JSON ${filePath}: ${error.message}`;
        throw error;
    }
}

function resolveInside(baseDir, relativePath) {
    const resolvedBase = path.resolve(baseDir);
    const resolvedFile = path.resolve(resolvedBase, relativePath);
    const relative = path.relative(resolvedBase, resolvedFile);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Catalog manifest path escapes its directory: ${relativePath}`);
    }

    return resolvedFile;
}

function loadCatalogV2(baseDir = DEFAULT_CATALOG_DIR) {
    const manifestPath = path.resolve(baseDir, 'manifest.json');
    const manifest = readJson(manifestPath);
    const capabilities = readJson(resolveInside(baseDir, manifest.capabilities_file));
    const products = readJson(resolveInside(baseDir, manifest.products_file));

    return {
        catalog_schema: manifest.catalog_schema,
        schema_version: manifest.schema_version,
        catalog_revision: manifest.catalog_revision,
        lifecycle: manifest.lifecycle,
        capabilities,
        products,
    };
}

module.exports = {
    DEFAULT_CATALOG_DIR,
    loadCatalogV2,
    readJson,
};
