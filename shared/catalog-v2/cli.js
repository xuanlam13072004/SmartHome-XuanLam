'use strict';

const { compileCatalog, lintCatalog, loadCatalogV2 } = require('./index');

function main() {
    const catalog = loadCatalogV2(process.argv[2]);
    const result = lintCatalog(catalog);

    for (const warning of result.warnings) {
        process.stderr.write(`WARN ${warning.code} ${warning.path}: ${warning.message}\n`);
    }
    for (const error of result.errors) {
        process.stderr.write(`ERROR ${error.code} ${error.path}: ${error.message}\n`);
    }
    if (result.errors.length > 0) process.exitCode = 1;
    else {
        const compiled = compileCatalog(catalog);
        process.stdout.write(`Catalog V2 valid: ${catalog.capabilities.length} capabilities, ${compiled.products.length} products, ${result.warnings.length} warnings.\n`);
    }
}

main();
