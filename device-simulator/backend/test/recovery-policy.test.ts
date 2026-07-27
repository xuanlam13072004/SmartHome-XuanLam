import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRestoreRunRuntime } from '../src/runtime/recovery-policy';

test('paused and cleanup runs never restore MQTT runtime', () => {
    assert.equal(shouldRestoreRunRuntime('paused'), false);
    assert.equal(shouldRestoreRunRuntime('cleaning'), false);
    assert.equal(shouldRestoreRunRuntime('cleaned'), false);
    assert.equal(shouldRestoreRunRuntime('cleanup_blocked'), false);
});

test('active and retained completed runs restore their desired online devices', () => {
    assert.equal(shouldRestoreRunRuntime('queued'), true);
    assert.equal(shouldRestoreRunRuntime('running'), true);
    assert.equal(shouldRestoreRunRuntime('completed'), true);
    assert.equal(shouldRestoreRunRuntime('partial'), true);
});
