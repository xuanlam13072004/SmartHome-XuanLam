import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraOperationOutcome, DeviceOperationRejection } from '../src/runtime/camera-controller';

const product = {
    capability_instances: [
        { instance_id: 'camera', capability_id: 'camera_stream' },
        { instance_id: 'recording', capability_id: 'video_recording' },
        { instance_id: 'main_lock', capability_id: 'door_lock' },
    ],
} as any;

const rejection = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) => (
    error instanceof DeviceOperationRejection && error.reasonCode === code
));

test('virtual camera without an image source rejects live and playback honestly', () => {
    rejection(() => cameraOperationOutcome(product, { instance_id: 'camera', operation_name: 'create_stream_session' }), 'CAMERA_UNAVAILABLE');
    rejection(() => cameraOperationOutcome(product, { instance_id: 'recording', operation_name: 'create_playback_session' }), 'RECORDING_UNAVAILABLE');
});

test('virtual camera reports no recordings and deletes nothing', () => {
    assert.deepEqual(
        cameraOperationOutcome(product, { instance_id: 'recording', operation_name: 'list_recordings' }),
        { details: { ranges: [], next_cursor: null } },
    );
    assert.deepEqual(
        cameraOperationOutcome(product, { instance_id: 'recording', operation_name: 'delete_recordings' }),
        { details: { deleted_segments: 0, freed_bytes: 0 } },
    );
});

test('operations of other capabilities are left to their own controllers', () => {
    assert.equal(cameraOperationOutcome(product, { instance_id: 'main_lock', operation_name: 'unlock' }), null);
    assert.equal(cameraOperationOutcome(product, { instance_id: 'missing', operation_name: 'x' }), null);
});
