import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { getCachedCatalog } from '../../catalog/loader';

const catalogRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/api/catalog/products', async () => ({
        success: true,
        products: getCachedCatalog().map((product) => ({
            id: product.product_id,
            display_name: product.presentation?.display_name || product.model_name,
            category: product.category,
            description: product.presentation?.description || product.description || '',
            icon: product.presentation?.icon || 'device_unknown',
            ui_profile: product.ui_profile || 'generic',
            capability_count: product.capability_instances.length,
        })),
    }));
};

export default catalogRoutes;
