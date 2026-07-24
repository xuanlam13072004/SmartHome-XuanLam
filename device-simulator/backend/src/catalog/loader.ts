import { env } from '../config/env';

export interface ProductCatalog {
    id: string;
    display_name: string;
    category: string;
    capabilities: any[];
}

let cachedProducts: ProductCatalog[] = [];

export const loadCatalog = async (): Promise<ProductCatalog[]> => {
    try {
        const url = `${env.API_GATEWAY_URL}/products`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch catalog: ${response.statusText}`);
        }
        
        const data = await response.json();
        if (data.success && data.products) {
            cachedProducts = data.products;
            return cachedProducts;
        }
        throw new Error('Invalid catalog format');
    } catch (error) {
        console.error('Error loading product catalog:', error);
        throw error;
    }
};

export const getCachedCatalog = (): ProductCatalog[] => {
    return cachedProducts;
};
