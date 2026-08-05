import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { getCachedCatalog } from '../../catalog/loader';

const catalogRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/api/catalog/products', async () => ({
        success: true,
        products: getCachedCatalog().map((product) => ({
            id: product.product_id,
            display_name: product.model_name,
            category: product.category,
            capability_count: product.capability_instances.length,
        })),
    }));
};

export default catalogRoutes;
