import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getProduct,
    loadCatalog,
    ProductContractUnavailableError,
} from '../src/catalog/loader';

const product = (productId: string, productRevision: number) => ({
    schema: 'compiled.product.v2',
    product_id: productId,
    catalog_revision: productRevision,
    capability_instances: [],
});

test('catalog loader accepts independent revisions for products in one catalog', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({
        success: true,
        catalog_revision: 2,
        products: [
            product('prod_revision_1', 1),
            product('prod_revision_2', 2),
        ],
    }), { status: 200 });

    const products = await loadCatalog();

    assert.deepEqual(
        products.map(item => [item.product_id, item.catalog_revision]),
        [['prod_revision_1', 1], ['prod_revision_2', 2]],
    );
});

test('catalog loader still rejects an invalid product revision', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({
        success: true,
        catalog_revision: 2,
        products: [product('prod_invalid', 0)],
    }), { status: 200 });

    await assert.rejects(
        loadCatalog(),
        /Product prod_invalid has an invalid compiled contract/,
    );
});

test('runtime lookup never silently upgrades a pinned device revision', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({
        success: true,
        catalog_revision: 3,
        products: [product('prod_roof_controller', 2)],
    }), { status: 200 });

    await loadCatalog();

    assert.throws(
        () => getProduct('prod_roof_controller', 1),
        (error: unknown) => (
            error instanceof ProductContractUnavailableError
            && error.expectedRevision === 1
            && error.availableRevision === 2
        ),
    );
    assert.equal(getProduct('prod_roof_controller', 2).catalog_revision, 2);
});
