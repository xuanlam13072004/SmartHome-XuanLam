import type { ProductCatalog } from '../catalog/loader';

/**
 * Camera operation fallback (docs/architecture/camera-contract.md).
 *
 * Products with both camera_stream and video_recording run the virtual camera
 * firmware in security-camera.ts. This fallback only answers for a Product
 * that declares camera capabilities without that firmware: like a camera with
 * no image source and an empty card, it rejects live and playback sessions,
 * lists no recordings and deletes nothing. It never fabricates a locator.
 */

export class DeviceOperationRejection extends Error {
    constructor(readonly reasonCode: string, message: string) {
        super(message);
        this.name = 'DeviceOperationRejection';
    }
}

export interface CameraOperationOutcome {
    details: Record<string, unknown>;
}

export const cameraOperationOutcome = (
    product: ProductCatalog,
    operation: { instance_id: string; operation_name: string },
): CameraOperationOutcome | null => {
    const instance = product.capability_instances.find(
        (candidate) => candidate.instance_id === operation.instance_id,
    );
    if (!instance) return null;
    if (instance.capability_id === 'camera_stream') {
        if (operation.operation_name === 'create_stream_session') {
            throw new DeviceOperationRejection(
                'CAMERA_UNAVAILABLE',
                'The virtual camera has no image source yet',
            );
        }
        return null;
    }
    if (instance.capability_id === 'video_recording') {
        switch (operation.operation_name) {
            case 'list_recordings':
                return { details: { ranges: [], next_cursor: null } };
            case 'create_playback_session':
                throw new DeviceOperationRejection(
                    'RECORDING_UNAVAILABLE',
                    'The virtual camera has no recordings yet',
                );
            case 'delete_recordings':
                return { details: { deleted_segments: 0, freed_bytes: 0 } };
            default:
                return null;
        }
    }
    return null;
};
