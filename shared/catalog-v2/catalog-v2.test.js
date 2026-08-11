'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { compileCatalog, lintCatalog, loadCatalogV2 } = require('./index');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('Catalog V2 source is valid and contains four stable product IDs', () => {
    const catalog = loadCatalogV2();
    const result = lintCatalog(catalog);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(
        catalog.products.map(product => product.product_id),
        [
            'prod_entrance_controller',
            'prod_roof_controller',
            'prod_hazard_mitigation',
            'prod_irrigation_manager',
        ],
    );
    assert.equal(catalog.capabilities.some(capability => capability.capability_id === 'generic_switch'), false);
});

test('compiler emits JSON-safe namespaced state without Map or Set values', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const entrance = compiled.product_index.prod_entrance_controller;

    assert.equal(entrance.ui_profile, 'entrance_controller');
    assert.equal(entrance.ui_profile_version, 1);
    assert.equal(entrance.firmware_default_state.instances.main_lock.reported.lock_state, 'unknown');
    assert.equal(entrance.firmware_default_state.instances.main_lock.desired.target_lock_state, 'locked');
    assert.deepEqual(entrance.firmware_default_state.instances.lcd.reported.displayed_lines, ['', '', '', '']);
    assert.equal(entrance.reported_state_seed_policy, 'device_report_only');
    assert.equal(
        entrance.property_schemas['instances.main_lock.reported.lock_state'].path,
        'instances.main_lock.reported.lock_state',
    );
    assert.doesNotThrow(() => JSON.stringify(compiled));

    const visit = value => {
        assert.equal(value instanceof Map, false);
        assert.equal(value instanceof Set, false);
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(compiled);
});

test('system diagnostics exposes an explicit firmware health signal', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const system = compiled.product_index.prod_entrance_controller.capability_instances
        .find(instance => instance.capability_id === 'system_diagnostics');
    const firmwareStatus = system.properties.find(property => property.id === 'firmware_status');

    assert.deepEqual(firmwareStatus.enum, ['unknown', 'healthy', 'fault']);
    assert.equal(firmwareStatus.default, 'unknown');
    assert.equal(firmwareStatus.presentation.ui_hint, 'firmware_health');
});

test('runtime contract contains no unconfirmed hazard hardware', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const hazard = compiled.product_index.prod_hazard_mitigation;

    assert.deepEqual(hazard.planned_capability_instances, []);
    for (const removed of ['load_cutoff', 'exhaust_fan', 'kitchen_power']) {
        assert.equal(hazard.capability_instances.some(instance => instance.instance_id === removed), false);
        assert.equal(Object.keys(hazard.operations).some(key => key.startsWith(`${removed}.`)), false);
    }
});

test('entrance credentials are write-only, owner-only and absent from generic operations', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const entrance = compiled.product_index.prod_entrance_controller;
    const pinInstance = entrance.capability_instances.find(instance => instance.instance_id === 'pin_auth');
    const pinCredential = pinInstance.credentials.find(credential => credential.id === 'pin');

    assert.equal(pinCredential.permission, 'credential.manage');
    assert.equal(pinCredential.delegable, false);
    assert.equal(pinCredential.write_only, true);
    assert.equal(pinCredential.verification_authority, 'device_firmware');
    assert.equal(pinCredential.storage, 'device_secure_storage');
    assert.equal(pinCredential.offline_usable, true);
    assert.equal(pinCredential.management_success_condition, 'persisted_on_device');
    assert.equal(
        Object.values(entrance.operations).some(operation => Object.keys(operation.input).some(name => /pin|password|secret/i.test(name))),
        false,
    );
});

test('entrance is edge-reviewed and every active capability keeps reported authority on firmware', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const entrance = compiled.product_index.prod_entrance_controller;

    assert.equal(entrance.contract_maturity, 'edge_reviewed');
    for (const instance of entrance.capability_instances) {
        assert.equal(instance.runtime.reported_state_authority, 'device_firmware');
        for (const property of instance.properties) {
            assert.equal(
                property.state_authority,
                property.channel === 'desired' ? 'backend_intent' : 'device_firmware',
            );
            assert.equal(typeof property.persistence, 'string');
        }
    }
});

test('entrance physical operations execute on device and define offline and completion semantics', () => {
    const entrance = compileCatalog(loadCatalogV2()).product_index.prod_entrance_controller;
    const unlock = entrance.operations['main_lock.unlock'];
    const lcd = entrance.operations['lcd.set_custom_message'];

    assert.equal(unlock.execution_authority, 'device_firmware');
    assert.deepEqual(unlock.offline_behavior, {
        remote_available: false,
        local_equivalent: true,
    });
    assert.deepEqual(unlock.ack_policy, {
        success_condition: 'effect_applied',
        completion_signal: 'reported_state',
        reference: 'lock_state',
    });
    assert.equal(lcd.execution_authority, 'device_firmware');
    assert.equal(lcd.offline_behavior.local_equivalent, false);
    assert.equal(lcd.ack_policy.reference, 'displayed_lines');
    const lockState = entrance.property_schemas['instances.main_lock.reported.lock_state'];
    assert.equal(lockState.enum.includes('unknown'), true);
    assert.equal(lockState.enum.includes('jammed'), false);
    assert.equal(Object.keys(entrance.events).includes('main_lock.lock_jammed'), false);
});

test('camera resource is device-produced but backend-authorized', () => {
    const entrance = compileCatalog(loadCatalogV2()).product_index.prod_entrance_controller;
    const camera = entrance.capability_instances.find(instance => instance.instance_id === 'door_camera');
    const stream = entrance.resources['door_camera.live_stream'];
    const openStream = entrance.operations['door_camera.create_stream_session'];

    assert.equal(camera.runtime.execution_authority, 'hybrid_session');
    assert.equal(camera.runtime.offline_behavior, 'local_core_only');
    assert.equal(stream.producer, 'device_firmware');
    assert.equal(stream.authorization_authority, 'backend');
    assert.equal(openStream.ack_policy.completion_signal, 'resource');
    assert.equal(openStream.ack_policy.reference, 'live_stream');
});

test('entrance local policies keep authentication and credential commit on device', () => {
    const entrance = compileCatalog(loadCatalogV2()).product_index.prod_entrance_controller;
    const policies = Object.fromEntries(
        entrance.local_policies.map(policy => [policy.id, policy]),
    );

    assert.equal(policies.offline_authentication.enforced_locally, true);
    assert.equal(policies.credential_commit.enforced_locally, true);
    assert.equal(policies.failed_pin_lockout.enforced_locally, true);
});

test('LCD contract enforces four lines with at most twenty characters', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const entrance = compiled.product_index.prod_entrance_controller;
    const lcdOperation = entrance.operations['lcd.set_custom_message'];
    const lines = lcdOperation.input.lines;

    assert.equal(lines.type, 'array');
    assert.equal(lines.min_items, 4);
    assert.equal(lines.max_items, 4);
    assert.equal(lines.items.max_length, 20);
});

test('roof uses rain semantics and physical buttons are event-only', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const roof = compiled.product_index.prod_roof_controller;
    const rain = roof.capability_instances.find(instance => instance.instance_id === 'rain_sensor');
    const button = roof.capability_instances.find(instance => instance.instance_id === 'roof_button');

    assert.equal(rain.capability_id, 'rain_detection');
    assert.equal(roof.contract_maturity, 'edge_reviewed');
    assert.equal(button.semantic_role, 'local_toggle_input');
    assert.equal(button.properties.length, 0);
    assert.equal(button.operations.length, 0);
    assert.equal(button.events.some(event => event.id === 'button_pressed'), true);
    assert.equal(button.events.every(event => event.producer === 'device_firmware'), true);
});

test('roof exposes only four logical states without claiming position feedback', () => {
    const roof = compileCatalog(loadCatalogV2()).product_index.prod_roof_controller;
    const motor = roof.capability_instances.find(instance => instance.instance_id === 'roof_motor');
    const propertyIds = motor.properties.map(property => property.id);
    const operationIds = motor.operations.map(operation => operation.id);
    const eventIds = motor.events.map(event => event.id);
    const movement = motor.properties.find(property => property.id === 'movement');

    assert.equal(propertyIds.includes('current_position'), false);
    assert.equal(propertyIds.includes('target_position'), false);
    assert.equal(propertyIds.includes('obstruction_detected'), false);
    assert.equal(propertyIds.includes('max_run_seconds'), false);
    assert.equal(propertyIds.includes('last_command_source'), false);
    assert.equal(operationIds.includes('set_position'), false);
    assert.deepEqual(operationIds, ['open', 'close']);
    assert.equal(eventIds.includes('cover_obstructed'), false);
    assert.deepEqual(movement.enum, ['closed', 'opening', 'open', 'closing']);
    assert.equal(movement.default, 'closed');
    assert.equal(movement.persistence, 'device_nvs');
});

test('roof motor accepts only idempotent open and close operations', () => {
    const roof = compileCatalog(loadCatalogV2()).product_index.prod_roof_controller;
    const open = roof.operations['roof_motor.open'];
    const close = roof.operations['roof_motor.close'];

    assert.equal(open.execution_authority, 'device_firmware');
    assert.equal(open.offline_behavior.local_equivalent, true);
    assert.equal(open.ack_policy.reference, 'movement');
    assert.deepEqual(open.effects, [
        { type: 'expect_reported', property: 'movement', value: 'opening' },
    ]);
    assert.deepEqual(close.effects, [
        { type: 'expect_reported', property: 'movement', value: 'closing' },
    ]);
    assert.equal(open.idempotent, true);
    assert.equal(close.idempotent, true);
    assert.equal(roof.operations['roof_motor.stop'], undefined);
    assert.equal(roof.operations['roof_motor.set_max_run_seconds'], undefined);
});

test('roof rain policy and the only physical sensor remain device-local', () => {
    const roof = compileCatalog(loadCatalogV2()).product_index.prod_roof_controller;
    const policy = roof.capability_instances.find(instance => instance.instance_id === 'roof_automation');
    const sensorIds = ['rain_sensor'];

    assert.equal(policy.runtime.execution_authority, 'device_firmware');
    assert.equal(policy.runtime.configuration_persistence, 'device_nvs');
    assert.deepEqual(policy.properties.map(property => property.id), ['control_mode']);
    assert.deepEqual(policy.operations.map(operation => operation.id), ['set_control_mode']);
    assert.equal(policy.properties[0].persistence, 'device_nvs');
    assert.equal(
        roof.operations['roof_automation.set_control_mode'].ack_policy.success_condition,
        'persisted',
    );
    assert.equal(roof.operations['roof_automation.set_rain_protection'], undefined);
    assert.equal(
        roof.local_policies.some(policyDefinition => policyDefinition.id === 'rain_auto_close'),
        true,
    );
    for (const instanceId of sensorIds) {
        const instance = roof.capability_instances.find(item => item.instance_id === instanceId);
        assert.equal(instance.runtime.reported_state_authority, 'device_firmware');
        assert.equal(instance.runtime.offline_behavior, 'full_local');
    }
    for (const absent of ['solar_sensor', 'outdoor_temperature', 'outdoor_humidity']) {
        assert.equal(roof.capability_instances.some(item => item.instance_id === absent), false);
    }
});

test('hazard contract matches MQ2, flame sensor, DHT11, buzzer and mute button', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const hazard = compiled.product_index.prod_hazard_mitigation;
    const incident = hazard.capability_instances.find(instance => instance.instance_id === 'hazard');
    const siren = hazard.capability_instances.find(instance => instance.instance_id === 'alarm_siren');
    const temperature = hazard.capability_instances.find(instance => instance.instance_id === 'kitchen_temperature');
    const humidity = hazard.capability_instances.find(instance => instance.instance_id === 'kitchen_humidity');
    const muteButton = hazard.capability_instances.find(instance => instance.instance_id === 'mute_button');

    assert.equal(hazard.contract_maturity, 'edge_reviewed');
    assert.equal(hazard.connectivity_profiles.includes('ethernet'), false);
    assert.equal(siren.capability_id, 'alarm_siren');
    assert.equal(temperature.capability_id, 'temperature_measurement');
    assert.equal(humidity.capability_id, 'humidity_measurement');
    assert.equal(muteButton.capability_id, 'local_button');
    assert.equal(incident.properties.some(property => property.id === 'alarm_state'), false);
    assert.deepEqual(
        incident.properties.find(property => property.id === 'incident_state').enum,
        ['idle', 'active', 'acknowledged'],
    );
    assert.equal(incident.properties.find(property => property.id === 'risk_level').default, 'sensor_fault');

    const acknowledge = incident.operations.find(operation => operation.id === 'acknowledge_incident');
    const reset = incident.operations.find(operation => operation.id === 'reset_incident');
    assert.equal(acknowledge.offline_behavior.local_equivalent, false);
    assert.deepEqual(acknowledge.effects, [
        { type: 'expect_reported', property: 'incident_state', value: 'acknowledged' },
    ]);
    assert.equal(reset.execution_authority, 'device_firmware');
    assert.equal(reset.confirmation, 'reauthenticate');
    assert.equal(reset.safety_constraints.includes('hazard_cleared'), true);
    assert.equal(reset.safety_constraints.includes('sensors_healthy'), true);

    const mute = siren.operations.find(operation => operation.id === 'mute_siren');
    assert.equal(mute.execution_authority, 'device_firmware');
    assert.equal(mute.offline_behavior.local_equivalent, true);
    assert.deepEqual(mute.effects, [
        { type: 'expect_reported', property: 'audible_state', value: 'muted' },
    ]);
    assert.equal(mute.safety_constraints.includes('mitigation_continues'), true);

    assert.equal(hazard.capability_instances.some(instance => instance.instance_id === 'exhaust_fan'), false);
    assert.equal(hazard.capability_instances.some(instance => instance.instance_id === 'kitchen_power'), false);
});

test('active hazard capabilities are device-authoritative and remain locally safe offline', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const hazard = compiled.product_index.prod_hazard_mitigation;

    for (const instance of hazard.capability_instances) {
        assert.equal(instance.runtime.execution_authority, 'device_firmware');
        assert.equal(instance.runtime.reported_state_authority, 'device_firmware');
        assert.equal(instance.runtime.offline_behavior, 'full_local');
        for (const property of instance.properties) {
            assert.equal(property.state_authority, 'device_firmware');
        }
        for (const event of instance.events) {
            assert.equal(event.producer, 'device_firmware');
        }
    }

    assert.equal(
        hazard.local_policies.some(policy => policy.id === 'temporary_mute'),
        true,
    );
    assert.equal(
        hazard.local_policies.some(policy => policy.id === 'fail_safe_sensor_state'),
        true,
    );
    assert.equal(
        hazard.local_policies.some(policy => policy.id === 'safe_power_restore'),
        false,
    );
});

test('irrigation cannot start an unbounded pump operation', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const irrigation = compiled.product_index.prod_irrigation_manager;
    const water = irrigation.operations['irrigation_pump.water_for_duration'];
    const pump = irrigation.capability_instances.find(instance => instance.instance_id === 'irrigation_pump');
    const reservoir = irrigation.capability_instances.find(instance => instance.instance_id === 'reservoir');
    const policy = irrigation.capability_instances.find(instance => instance.instance_id === 'irrigation_automation');

    assert.equal(irrigation.contract_maturity, 'edge_reviewed');
    assert.equal(water.input.duration_seconds.minimum, 30);
    assert.equal(water.input.duration_seconds.maximum, 3600);
    assert.equal(water.execution_authority, 'device_firmware');
    assert.equal(water.ack_policy.reference, 'pump_output_state');
    assert.equal(water.safety_constraints.includes('reservoir_sensor_ready'), true);
    assert.equal(water.safety_constraints.includes('water_available'), true);
    assert.equal(water.safety_constraints.includes('within_configured_runtime'), true);
    assert.equal(water.safety_constraints.includes('cooldown_satisfied'), true);
    assert.equal(Object.keys(irrigation.operations).some(key => /set_switch/i.test(key)), false);

    assert.deepEqual(
        pump.properties.find(property => property.id === 'pump_output_state').enum,
        ['stopped', 'running'],
    );
    assert.equal(pump.properties.some(property => property.id === 'pump_state'), false);
    assert.equal(pump.events.some(event => event.id === 'pump_fault'), false);
    assert.equal(pump.events.some(event => event.id === 'watering_rejected'), true);

    const waterAvailability = reservoir.properties.find(property => property.id === 'water_availability');
    assert.equal(waterAvailability.default, 'unknown');
    assert.deepEqual(waterAvailability.enum, ['unknown', 'available', 'low', 'empty']);

    assert.equal(policy.runtime.configuration_persistence, 'device_nvs');
    assert.equal(
        policy.properties.find(property => property.id === 'control_mode').persistence,
        'device_nvs',
    );
    for (const propertyId of [
        'target_moisture',
        'moisture_hysteresis',
        'default_cycle_duration_seconds',
        'maximum_runtime_seconds',
        'cooldown_seconds',
    ]) {
        const property = policy.properties.find(item => item.id === propertyId);
        assert.equal(
            property.persistence,
            'none',
        );
        assert.equal(
            property.presentation.ui_hint,
            'firmware_note',
        );
        assert.equal(property.state_authority, 'product_catalog');
        assert.equal(property.history, 'none');
        assert.deepEqual(property.automation, { trigger: false, condition: false });
    }
    assert.equal(
        irrigation.firmware_default_state.instances.irrigation_automation.reported.target_moisture,
        undefined,
    );
    assert.equal(
        irrigation.property_schemas['instances.irrigation_automation.reported.target_moisture'],
        undefined,
    );
    assert.deepEqual(policy.operations.map(operation => operation.id), ['set_control_mode']);
    assert.equal(irrigation.operations['irrigation_automation.set_moisture_policy'], undefined);
    assert.equal(irrigation.operations['irrigation_automation.set_cycle_configuration'], undefined);
    assert.equal(policy.events.some(event => event.id === 'schedule_executed'), false);
});

test('active irrigation runtime remains device-authoritative while fixed policy metadata comes from Catalog', () => {
    const compiled = compileCatalog(loadCatalogV2());
    const irrigation = compiled.product_index.prod_irrigation_manager;

    for (const instance of irrigation.capability_instances) {
        assert.equal(instance.runtime.execution_authority, 'device_firmware');
        assert.equal(instance.runtime.reported_state_authority, 'device_firmware');
        assert.equal(instance.runtime.offline_behavior, 'full_local');
        for (const property of instance.properties) {
            assert.equal(
                ['device_firmware', 'product_catalog'].includes(property.state_authority),
                true,
            );
        }
        for (const event of instance.events) {
            assert.equal(event.producer, 'device_firmware');
        }
    }

    const policy = irrigation.capability_instances.find(
        instance => instance.instance_id === 'irrigation_automation',
    );
    assert.deepEqual(policy.operations.map(operation => operation.id), ['set_control_mode']);
    assert.equal(
        irrigation.local_policies.some(
            localPolicy => localPolicy.id === 'firmware_owned_irrigation_policy',
        ),
        true,
    );
    assert.equal(
        irrigation.local_policies.some(localPolicy => localPolicy.id === 'safe_boot_output'),
        true,
    );
    assert.equal(
        irrigation.local_policies.some(localPolicy => localPolicy.id === 'bounded_local_cycle'),
        true,
    );
});

test('linter rejects duplicate instances', () => {
    const catalog = clone(loadCatalogV2());
    catalog.products[0].capability_instances.push(clone(catalog.products[0].capability_instances[0]));

    const result = lintCatalog(catalog);
    assert.equal(result.errors.some(error => error.code === 'DUPLICATE_INSTANCE'), true);
});

test('linter rejects secret fields in generic operations', () => {
    const catalog = clone(loadCatalogV2());
    catalog.capabilities.find(capability => capability.capability_id === 'door_lock').operations[0].input.pin_code = {
        type: 'string',
    };

    const result = lintCatalog(catalog);
    assert.equal(result.errors.some(error => error.code === 'SECRET_IN_GENERIC_OPERATION'), true);
});

test('linter requires reauthentication for dangerous operations', () => {
    const catalog = clone(loadCatalogV2());
    const hazard = catalog.capabilities.find(capability => capability.capability_id === 'hazard_controller');
    hazard.operations.find(operation => operation.id === 'reset_incident').confirmation = 'confirm';

    const result = lintCatalog(catalog);
    assert.equal(result.errors.some(error => error.code === 'DANGEROUS_OPERATION_REAUTH_REQUIRED'), true);
});

test('linter rejects an edge-reviewed capability without runtime authority', () => {
    const catalog = clone(loadCatalogV2());
    delete catalog.capabilities.find(
        capability => capability.capability_id === 'door_lock',
    ).runtime;

    const result = lintCatalog(catalog);
    assert.equal(result.errors.some(error => error.code === 'EDGE_RUNTIME_REQUIRED'), true);
});

test('linter rejects backend authority for reported physical state', () => {
    const catalog = clone(loadCatalogV2());
    catalog.capabilities.find(
        capability => capability.capability_id === 'door_lock',
    ).properties.find(property => property.id === 'lock_state').state_authority = 'backend_intent';

    const result = lintCatalog(catalog);
    assert.equal(result.errors.some(error => error.code === 'INVALID_STATE_AUTHORITY'), true);
});

test('linter rejects edge operation without ACK policy', () => {
    const catalog = clone(loadCatalogV2());
    delete catalog.capabilities.find(
        capability => capability.capability_id === 'door_lock',
    ).operations.find(operation => operation.id === 'unlock').ack_policy;

    const result = lintCatalog(catalog);
    assert.equal(result.errors.some(error => error.code === 'OPERATION_ACK_POLICY_REQUIRED'), true);
});

test('formal JSON schema document and all catalog source JSON files parse', () => {
    const catalogRoot = path.resolve(__dirname, '../../database/catalog-v2');
    for (const relativePath of [
        'manifest.json',
        'hardware-profile.json',
        'capabilities.json',
        'products.json',
        'schemas/catalog.schema.json',
    ]) {
        const content = fs.readFileSync(path.join(catalogRoot, relativePath), 'utf8');
        assert.doesNotThrow(() => JSON.parse(content), relativePath);
    }
});
