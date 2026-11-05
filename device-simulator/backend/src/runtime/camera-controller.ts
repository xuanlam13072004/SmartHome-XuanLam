import type { ProductCatalog } from '../catalog/loader';

/**
 * Virtual security camera, contract step 1 (docs/architecture/camera-contract.md).
 *
 * The webcam/microphone media pipeline (step 2) does not exist yet, so the
 * virtual camera answers truthfully, exactly as a physical camera with no
 * image source and an empty card would: live and playback sessions are
 * rejected, there are no recordings, and deleting removes nothing. It never
 * fabricates a stream locator; the Gateway builds media locators itself.
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
