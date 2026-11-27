import type { SimulatedDeviceRecord } from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';
import {
    getProduct,
    ProductContractUnavailableError,
    type ProductCatalog,
} from './loader';

const isRevision = (value: unknown): value is number => (
    Number.isInteger(value) && Number(value) > 0
);

const contractErrorMessage = (
    device: Pick<SimulatedDeviceRecord, 'mac' | 'product_id' | 'catalog_revision'>,
    error: unknown,
): string => {
    if (error instanceof ProductContractUnavailableError) {
        return `Thiết bị ${device.mac} đã claim Product ${device.product_id} revision ${device.catalog_revision}, nhưng runtime hiện tại chỉ có revision ${error.availableRevision ?? 'không xác định'}. Hãy migrate firmware/contract hoặc tạo lại thiết bị test.`;
    }
    return error instanceof Error ? error.message : String(error);
};

export const markDeviceContractError = async (
    device: Pick<SimulatedDeviceRecord, 'mac' | 'product_id' | 'catalog_revision'>,
    error: unknown,
): Promise<void> => {
    await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
        { mac: device.mac },
        {
            $set: {
                runtime_state: 'contract_error',
                last_error: contractErrorMessage(device, error).slice(0, 1000),
                updated_at: new Date(),
            },
        },
    );
};

/**
 * Resolve one immutable Product contract before a runtime is constructed.
 * Every record carries the revision it was made (and claimed) with, so a
 * restart never silently upgrades a device; a record without one gets the
 * current revision once, before it is registered with the factory API.
 */
export const resolveDeviceProduct = async (
    device: SimulatedDeviceRecord,
): Promise<ProductCatalog> => {
    try {
        let revision = device.catalog_revision;
        if (!isRevision(revision)) {
            if (device.provisioning_state === 'claimed') {
                throw new Error(`Claimed virtual device ${device.mac} has no Product revision in the registry`);
            }
            revision = getProduct(device.product_id).catalog_revision;
            await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices').updateOne(
                { mac: device.mac },
                {
                    $set: {
                        catalog_revision: revision,
                        updated_at: new Date(),
                    },
                },
            );
            device.catalog_revision = revision;
        }
        return getProduct(device.product_id, revision);
    } catch (error) {
        await markDeviceContractError(device, error);
        throw error;
    }
};

export const assertClaimedProductIdentity = (
    device: Pick<SimulatedDeviceRecord, 'mac' | 'product_id' | 'catalog_revision'>,
    claimed: { product_id: string; catalog_revision?: number | string },
): void => {
    const claimedRevision = Number(claimed.catalog_revision);
    if (
        claimed.product_id !== device.product_id
        || !isRevision(claimedRevision)
        || claimedRevision !== device.catalog_revision
    ) {
        throw new Error(
            `Claimed Product identity for ${device.mac} does not match the provisioned contract (${device.product_id}@${device.catalog_revision})`,
        );
    }
};
