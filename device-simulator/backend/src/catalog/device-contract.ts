import type { SimulatedDeviceRecord } from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getPgPool } from '../infrastructure/postgres/client';
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

const recoverLegacyClaimedRevision = async (
    device: SimulatedDeviceRecord,
): Promise<number> => {
    const result = await getPgPool().query<{
        product_id: string;
        catalog_revision: number | string;
    }>(
        `SELECT product_id, catalog_revision
         FROM device_metadata
         WHERE mac = $1 AND is_active = true`,
        [device.mac],
    );
    const claimed = result.rows[0];
    if (!claimed) {
        throw new Error(`Claimed metadata for virtual device ${device.mac} is unavailable`);
    }
    if (claimed.product_id !== device.product_id) {
        throw new Error(
            `Registry Product ${device.product_id} does not match claimed Product ${claimed.product_id} for ${device.mac}`,
        );
    }
    const revision = Number(claimed.catalog_revision);
    if (!isRevision(revision)) {
        throw new Error(`Claimed Product revision for ${device.mac} is invalid`);
    }
    return revision;
};

/**
 * Resolve one immutable Product contract before a runtime is constructed.
 * Legacy records are backfilled from the main ownership database, never from
 * the newest Catalog revision, so a restart cannot silently upgrade a device.
 */
export const resolveDeviceProduct = async (
    device: SimulatedDeviceRecord,
): Promise<ProductCatalog> => {
    try {
        let revision = device.catalog_revision;
        if (!isRevision(revision)) {
            revision = device.provisioning_state === 'claimed'
                ? await recoverLegacyClaimedRevision(device)
                : getProduct(device.product_id).catalog_revision;
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
