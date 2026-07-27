import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { getCachedCatalog } from '../../catalog/loader';

const catalogRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/api/catalog/products', async () => ({
        success: true,
        products: getCachedCatalog().map((product) => ({
            id: product.id,
            display_name: product.display_name,
            category: product.category,
            capability_count: product.capabilityInstances.length,
        })),
    }));
};

export default catalogRoutes;
