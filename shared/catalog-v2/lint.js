'use strict';

const IDENTIFIER = /^[a-z][a-z0-9_]{1,63}$/;
const PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SECRET_INPUT = /(^|_)(pin|password|secret|face_template|embedding|fingerprint_template|rfid_value)($|_)/i;
const VALUE_TYPES = new Set(['boolean', 'number', 'integer', 'string', 'array']);
const CHANNELS = new Set(['reported', 'desired', 'diagnostic']);
const EXECUTION_AUTHORITIES = new Set(['device_firmware', 'hybrid_session']);
const OFFLINE_BEHAVIORS = new Set(['full_local', 'local_core_only', 'requires_connectivity']);
const CONFIG_PERSISTENCE = new Set(['none', 'device_runtime', 'device_nvs', 'device_secure_storage']);
const STATE_PERSISTENCE = new Set(['volatile', 'device_nvs', 'device_secure_storage', 'none']);
const ACK_SUCCESS_CONDITIONS = new Set(['accepted', 'persisted', 'effect_applied', 'resource_ready']);
const ACK_COMPLETION_SIGNALS = new Set(['ack', 'reported_state', 'event', 'resource']);
const EFFECT_TYPES = new Set([
    'set_desired',
    'expect_reported',
    'create_event',
    'create_resource_session',
    'create_credential_job',
]);

function issue(code, path, message) {
    return { code, path, message };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateValue(value, schema) {
    if (value === null) {
        return schema.nullable === true ? null : 'value is null but schema is not nullable';
    }

    switch (schema.type) {
        case 'boolean':
            if (typeof value !== 'boolean') return 'expected boolean';
            break;
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected finite number';
            break;
        case 'integer':
            if (!Number.isInteger(value)) return 'expected integer';
            break;
        case 'string':
            if (typeof value !== 'string') return 'expected string';
            if (schema.min_length !== undefined && value.length < schema.min_length) return `string is shorter than ${schema.min_length}`;
            if (schema.max_length !== undefined && value.length > schema.max_length) return `string is longer than ${schema.max_length}`;
            break;
        case 'array': {
            if (!Array.isArray(value)) return 'expected array';
            if (schema.min_items !== undefined && value.length < schema.min_items) return `array has fewer than ${schema.min_items} items`;
            if (schema.max_items !== undefined && value.length > schema.max_items) return `array has more than ${schema.max_items} items`;
            if (schema.items) {
                for (let index = 0; index < value.length; index += 1) {
                    const itemError = validateValue(value[index], schema.items);
                    if (itemError) return `item ${index}: ${itemError}`;
                }
            }
            break;
        }
        default:
            return `unsupported type ${schema.type}`;
    }

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) return `value is below minimum ${schema.minimum}`;
        if (schema.maximum !== undefined && value > schema.maximum) return `value is above maximum ${schema.maximum}`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) {
        return 'value is not in enum';
    }
    return null;
}

function lintValueSchema(schema, path, errors, { property = false } = {}) {
    if (!isPlainObject(schema)) {
        errors.push(issue('INVALID_VALUE_SCHEMA', path, 'Value schema must be an object.'));
        return;
    }
    if (!VALUE_TYPES.has(schema.type)) {
        errors.push(issue('INVALID_VALUE_TYPE', `${path}.type`, `Unsupported value type: ${schema.type}`));
        return;
    }
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
        errors.push(issue('INVALID_RANGE', path, 'minimum cannot be greater than maximum.'));
    }
    if (schema.type === 'array' && !isPlainObject(schema.items)) {
        errors.push(issue('ARRAY_ITEMS_REQUIRED', `${path}.items`, 'Array schemas must declare an item schema.'));
    }
    if (schema.unit && !['number', 'integer'].includes(schema.type)) {
        errors.push(issue('UNIT_ON_NON_NUMERIC', `${path}.unit`, 'Only numeric values may declare a unit.'));
    }
    if (property && !CHANNELS.has(schema.channel)) {
        errors.push(issue('INVALID_PROPERTY_CHANNEL', `${path}.channel`, `Unsupported channel: ${schema.channel}`));
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
        const valueError = validateValue(schema.default, schema);
        if (valueError) errors.push(issue('INVALID_DEFAULT', `${path}.default`, valueError));
    } else if (property && schema.required === true) {
        errors.push(issue('REQUIRED_DEFAULT_MISSING', path, 'Required properties must declare an explicit default.'));
    }
}

function lintCapability(capability, path, errors, warnings) {
    if (!IDENTIFIER.test(capability.capability_id || '')) {
        errors.push(issue('INVALID_CAPABILITY_ID', `${path}.capability_id`, 'Capability ID must be a stable snake_case identifier.'));
    }
    if (!Number.isInteger(capability.revision) || capability.revision < 1) {
        errors.push(issue('INVALID_CAPABILITY_REVISION', `${path}.revision`, 'Capability revision must be a positive integer.'));
    }

    const properties = Array.isArray(capability.properties) ? capability.properties : [];
    const operations = Array.isArray(capability.operations) ? capability.operations : [];
    const events = Array.isArray(capability.events) ? capability.events : [];
    const resources = Array.isArray(capability.resources) ? capability.resources : [];
    const credentials = Array.isArray(capability.credentials) ? capability.credentials : [];
    const propertyIds = new Set();
    const declaredEventIds = new Set(events.map(event => event.id));
    const declaredResourceIds = new Set(resources.map(resource => resource.id));
    const eventIds = new Set();
    const resourceIds = new Set();

    properties.forEach((property, index) => {
        const propertyPath = `${path}.properties[${index}]`;
        if (!IDENTIFIER.test(property.id || '')) errors.push(issue('INVALID_PROPERTY_ID', `${propertyPath}.id`, 'Property ID must be snake_case.'));
        if (propertyIds.has(property.id)) errors.push(issue('DUPLICATE_PROPERTY', `${propertyPath}.id`, `Duplicate property ${property.id}.`));
        propertyIds.add(property.id);
        lintValueSchema(property, propertyPath, errors, { property: true });
        if (!isPlainObject(property.presentation) || !property.presentation.ui_hint || !property.presentation.label) {
            errors.push(issue('PROPERTY_PRESENTATION_REQUIRED', `${propertyPath}.presentation`, 'Property presentation requires ui_hint and label.'));
        }
    });

    const operationIds = new Set();
    operations.forEach((operation, index) => {
        const operationPath = `${path}.operations[${index}]`;
        if (!IDENTIFIER.test(operation.id || '')) errors.push(issue('INVALID_OPERATION_ID', `${operationPath}.id`, 'Operation ID must be snake_case.'));
        if (operationIds.has(operation.id)) errors.push(issue('DUPLICATE_OPERATION', `${operationPath}.id`, `Duplicate operation ${operation.id}.`));
        operationIds.add(operation.id);
        if (!PERMISSION.test(operation.permission || '')) errors.push(issue('INVALID_PERMISSION', `${operationPath}.permission`, 'Operation permission must be a dotted scope.'));
        if (operation.risk === 'dangerous' && operation.confirmation !== 'reauthenticate') {
            errors.push(issue('DANGEROUS_OPERATION_REAUTH_REQUIRED', operationPath, 'Dangerous operations must require reauthentication.'));
        }
        if (!Number.isInteger(operation.timeout_ms) || operation.timeout_ms < 100) {
            errors.push(issue('INVALID_OPERATION_TIMEOUT', `${operationPath}.timeout_ms`, 'Operation timeout must be at least 100ms.'));
        }

        const input = isPlainObject(operation.input) ? operation.input : {};
        for (const [name, inputSchema] of Object.entries(input)) {
            lintValueSchema(inputSchema, `${operationPath}.input.${name}`, errors);
            if (SECRET_INPUT.test(name)) {
                errors.push(issue('SECRET_IN_GENERIC_OPERATION', `${operationPath}.input.${name}`, 'Credentials must use the credential service, not a generic operation payload.'));
            }
        }

        const effects = Array.isArray(operation.effects) ? operation.effects : [];
        if (effects.length === 0) warnings.push(issue('OPERATION_WITHOUT_EFFECT', `${operationPath}.effects`, 'Operation has no declarative effect.'));
        effects.forEach((effect, effectIndex) => {
            const effectPath = `${operationPath}.effects[${effectIndex}]`;
            if (!EFFECT_TYPES.has(effect.type)) errors.push(issue('INVALID_EFFECT_TYPE', `${effectPath}.type`, `Unsupported effect type: ${effect.type}`));
            if (['set_desired', 'expect_reported'].includes(effect.type) && !propertyIds.has(effect.property)) {
                errors.push(issue('EFFECT_PROPERTY_NOT_FOUND', `${effectPath}.property`, `Property ${effect.property} does not exist in the capability.`));
            }
            if (effect.type === 'create_event') {
                const eventId = String(effect.property || '').replace(/^events\./, '');
                if (!declaredEventIds.has(eventId)) errors.push(issue('EFFECT_EVENT_NOT_FOUND', `${effectPath}.property`, `Event ${eventId} does not exist.`));
            }
            if (effect.type === 'create_resource_session') {
                const resourceId = String(effect.property || '').replace(/^resources\./, '');
                if (!declaredResourceIds.has(resourceId)) errors.push(issue('EFFECT_RESOURCE_NOT_FOUND', `${effectPath}.property`, `Resource ${resourceId} does not exist.`));
            }
            if (effect.value_from) {
                const inputName = effect.value_from.replace(/^input\./, '');
                if (!Object.prototype.hasOwnProperty.call(input, inputName)) {
                    errors.push(issue('EFFECT_INPUT_NOT_FOUND', `${effectPath}.value_from`, `Input ${inputName} does not exist.`));
                }
            }
        });
    });

    events.forEach((event, index) => {
        const eventPath = `${path}.events[${index}]`;
        if (!IDENTIFIER.test(event.id || '')) errors.push(issue('INVALID_EVENT_ID', `${eventPath}.id`, 'Event ID must be snake_case.'));
        if (eventIds.has(event.id)) errors.push(issue('DUPLICATE_EVENT', `${eventPath}.id`, `Duplicate event ${event.id}.`));
        eventIds.add(event.id);
        for (const [name, dataSchema] of Object.entries(event.data || {})) {
            lintValueSchema(dataSchema, `${eventPath}.data.${name}`, errors);
            if (SECRET_INPUT.test(name)) errors.push(issue('SECRET_IN_EVENT', `${eventPath}.data.${name}`, 'Events must never contain credential secrets.'));
        }
    });

    resources.forEach((resource, index) => {
        const resourcePath = `${path}.resources[${index}]`;
        if (resourceIds.has(resource.id)) errors.push(issue('DUPLICATE_RESOURCE', `${resourcePath}.id`, `Duplicate resource ${resource.id}.`));
        resourceIds.add(resource.id);
        if (!PERMISSION.test(resource.permission || '')) errors.push(issue('INVALID_PERMISSION', `${resourcePath}.permission`, 'Resource permission must be a dotted scope.'));
        if (!Number.isInteger(resource.session_ttl_seconds) || resource.session_ttl_seconds < 1 || resource.session_ttl_seconds > 3600) {
            errors.push(issue('INVALID_RESOURCE_TTL', `${resourcePath}.session_ttl_seconds`, 'Resource session TTL must be between 1 and 3600 seconds.'));
        }
    });

    const credentialIds = new Set();
    credentials.forEach((credential, index) => {
        const credentialPath = `${path}.credentials[${index}]`;
        if (credentialIds.has(credential.id)) errors.push(issue('DUPLICATE_CREDENTIAL', `${credentialPath}.id`, `Duplicate credential ${credential.id}.`));
        credentialIds.add(credential.id);
        if (credential.permission !== 'credential.manage') errors.push(issue('CREDENTIAL_PERMISSION_REQUIRED', `${credentialPath}.permission`, 'Credentials require credential.manage.'));
        if (credential.delegable !== false) errors.push(issue('CREDENTIAL_MUST_NOT_BE_DELEGABLE', `${credentialPath}.delegable`, 'Credential management is owner-only and non-delegable.'));
        if (credential.write_only !== true) errors.push(issue('CREDENTIAL_MUST_BE_WRITE_ONLY', `${credentialPath}.write_only`, 'Credential material must be write-only.'));
        if (credential.constraints) lintValueSchema(credential.constraints, `${credentialPath}.constraints`, errors);
    });

    if (properties.length + operations.length + events.length + resources.length + credentials.length === 0) {
        warnings.push(issue('EMPTY_CAPABILITY', path, 'Capability has no runtime contract.'));
    }
}

function lintEdgeCapabilityContract(capability, path, errors) {
    const runtime = capability.runtime;
    if (!isPlainObject(runtime)) {
        errors.push(issue('EDGE_RUNTIME_REQUIRED', `${path}.runtime`, 'Edge-reviewed capabilities require a runtime contract.'));
    } else {
        if (!EXECUTION_AUTHORITIES.has(runtime.execution_authority)) {
            errors.push(issue('INVALID_EXECUTION_AUTHORITY', `${path}.runtime.execution_authority`, 'Execution authority must remain on device firmware or an explicit hybrid resource session.'));
        }
        if (runtime.reported_state_authority !== 'device_firmware') {
            errors.push(issue('DEVICE_REPORTED_STATE_AUTHORITY_REQUIRED', `${path}.runtime.reported_state_authority`, 'Reported state authority must be device_firmware.'));
        }
        if (!OFFLINE_BEHAVIORS.has(runtime.offline_behavior)) {
            errors.push(issue('INVALID_OFFLINE_BEHAVIOR', `${path}.runtime.offline_behavior`, 'Capability offline behavior is missing or invalid.'));
        }
        if (!CONFIG_PERSISTENCE.has(runtime.configuration_persistence)) {
            errors.push(issue('INVALID_CONFIGURATION_PERSISTENCE', `${path}.runtime.configuration_persistence`, 'Capability configuration persistence is missing or invalid.'));
        }
    }

    const propertyIds = new Set((capability.properties || []).map(property => property.id));
    const eventIds = new Set((capability.events || []).map(event => event.id));
    const resourceIds = new Set((capability.resources || []).map(resource => resource.id));

    for (const [index, property] of (capability.properties || []).entries()) {
        const propertyPath = `${path}.properties[${index}]`;
        const expectedAuthority = property.channel === 'desired'
            ? 'backend_intent'
            : 'device_firmware';
        if (property.state_authority !== expectedAuthority) {
            errors.push(issue('INVALID_STATE_AUTHORITY', `${propertyPath}.state_authority`, `${property.channel} properties require ${expectedAuthority}.`));
        }
        if (!STATE_PERSISTENCE.has(property.persistence)) {
            errors.push(issue('STATE_PERSISTENCE_REQUIRED', `${propertyPath}.persistence`, 'Edge-reviewed properties require an explicit persistence policy.'));
        }
    }

    for (const [index, operation] of (capability.operations || []).entries()) {
        const operationPath = `${path}.operations[${index}]`;
        if (!EXECUTION_AUTHORITIES.has(operation.execution_authority)) {
            errors.push(issue('OPERATION_EXECUTION_AUTHORITY_REQUIRED', `${operationPath}.execution_authority`, 'Operation execution authority is required.'));
        }
        if (!isPlainObject(operation.offline_behavior)
            || typeof operation.offline_behavior.remote_available !== 'boolean'
            || typeof operation.offline_behavior.local_equivalent !== 'boolean') {
            errors.push(issue('OPERATION_OFFLINE_BEHAVIOR_REQUIRED', `${operationPath}.offline_behavior`, 'Operation offline behavior must declare remote_available and local_equivalent.'));
        } else if (operation.offline_behavior.remote_available !== false) {
            errors.push(issue('REMOTE_OPERATION_REQUIRES_BACKEND', `${operationPath}.offline_behavior.remote_available`, 'App remote operations are unavailable without backend connectivity.'));
        }

        const ack = operation.ack_policy;
        if (!isPlainObject(ack)
            || !ACK_SUCCESS_CONDITIONS.has(ack.success_condition)
            || !ACK_COMPLETION_SIGNALS.has(ack.completion_signal)) {
            errors.push(issue('OPERATION_ACK_POLICY_REQUIRED', `${operationPath}.ack_policy`, 'Operation ACK success and completion semantics are required.'));
            continue;
        }
        if (ack.completion_signal !== 'ack' && typeof ack.reference !== 'string') {
            errors.push(issue('ACK_REFERENCE_REQUIRED', `${operationPath}.ack_policy.reference`, 'Non-ACK completion signals require a reference.'));
        }
        if (ack.completion_signal === 'reported_state' && !propertyIds.has(ack.reference)) {
            errors.push(issue('ACK_PROPERTY_NOT_FOUND', `${operationPath}.ack_policy.reference`, `Reported property ${ack.reference} does not exist.`));
        }
        if (ack.completion_signal === 'event' && !eventIds.has(String(ack.reference || '').replace(/^events\./, ''))) {
            errors.push(issue('ACK_EVENT_NOT_FOUND', `${operationPath}.ack_policy.reference`, `Completion event ${ack.reference} does not exist.`));
        }
        if (ack.completion_signal === 'resource' && !resourceIds.has(String(ack.reference || '').replace(/^resources\./, ''))) {
            errors.push(issue('ACK_RESOURCE_NOT_FOUND', `${operationPath}.ack_policy.reference`, `Completion resource ${ack.reference} does not exist.`));
        }
    }

    for (const [index, event] of (capability.events || []).entries()) {
        if (event.producer !== 'device_firmware') {
            errors.push(issue('DEVICE_EVENT_PRODUCER_REQUIRED', `${path}.events[${index}].producer`, 'Physical Product events must be produced by device firmware.'));
        }
    }

    for (const [index, resource] of (capability.resources || []).entries()) {
        const resourcePath = `${path}.resources[${index}]`;
        if (resource.producer !== 'device_firmware') {
            errors.push(issue('DEVICE_RESOURCE_PRODUCER_REQUIRED', `${resourcePath}.producer`, 'Camera resources must originate from device firmware.'));
        }
        if (resource.authorization_authority !== 'backend') {
            errors.push(issue('RESOURCE_AUTHORITY_REQUIRED', `${resourcePath}.authorization_authority`, 'Backend must authorize protected resource sessions.'));
        }
    }

    for (const [index, credential] of (capability.credentials || []).entries()) {
        const credentialPath = `${path}.credentials[${index}]`;
        if (credential.verification_authority !== 'device_firmware') {
            errors.push(issue('DEVICE_CREDENTIAL_VERIFICATION_REQUIRED', `${credentialPath}.verification_authority`, 'Credential verification must work on device firmware.'));
        }
        if (credential.storage !== 'device_secure_storage') {
            errors.push(issue('DEVICE_CREDENTIAL_STORAGE_REQUIRED', `${credentialPath}.storage`, 'Credential verifier/template must use device secure storage.'));
        }
        if (credential.offline_usable !== true) {
            errors.push(issue('OFFLINE_CREDENTIAL_REQUIRED', `${credentialPath}.offline_usable`, 'Entrance credentials must remain usable offline.'));
        }
        if (credential.management_success_condition !== 'persisted_on_device') {
            errors.push(issue('CREDENTIAL_ACK_PERSISTENCE_REQUIRED', `${credentialPath}.management_success_condition`, 'Credential changes succeed only after device persistence.'));
        }
    }
}

function lintProduct(product, path, capabilityIndex, errors, warnings) {
    if (!IDENTIFIER.test(product.product_id || '')) errors.push(issue('INVALID_PRODUCT_ID', `${path}.product_id`, 'Product ID must be snake_case.'));
    if (/_v\d+$/i.test(product.product_id || '')) errors.push(issue('VERSIONED_PRODUCT_ID', `${path}.product_id`, 'Product version belongs in catalog_revision, not product_id.'));
    if (!Number.isInteger(product.catalog_revision) || product.catalog_revision < 1) errors.push(issue('INVALID_PRODUCT_REVISION', `${path}.catalog_revision`, 'Product revision must be positive.'));

    if (!['draft', 'edge_reviewed', 'approved'].includes(product.contract_maturity || 'draft')) {
        errors.push(issue('INVALID_CONTRACT_MATURITY', `${path}.contract_maturity`, 'Contract maturity must be draft, edge_reviewed or approved.'));
    }
    const requiresEdgeContract = ['edge_reviewed', 'approved'].includes(product.contract_maturity);
    const instances = Array.isArray(product.capability_instances) ? product.capability_instances : [];
    const instanceIds = new Set();
    const propertyPaths = new Set();
    let diagnosticsCount = 0;

    instances.forEach((instance, index) => {
        const instancePath = `${path}.capability_instances[${index}]`;
        if (!IDENTIFIER.test(instance.instance_id || '')) errors.push(issue('INVALID_INSTANCE_ID', `${instancePath}.instance_id`, 'Instance ID must be snake_case.'));
        if (instanceIds.has(instance.instance_id)) errors.push(issue('DUPLICATE_INSTANCE', `${instancePath}.instance_id`, `Duplicate instance ${instance.instance_id}.`));
        instanceIds.add(instance.instance_id);

        const capabilityKey = `${instance.capability_id}@${instance.capability_revision}`;
        const capability = capabilityIndex.get(capabilityKey);
        if (!capability) {
            errors.push(issue('CAPABILITY_REFERENCE_NOT_FOUND', instancePath, `Missing capability revision ${capabilityKey}.`));
            return;
        }
        if (instance.capability_id === 'generic_switch') errors.push(issue('GENERIC_SWITCH_FORBIDDEN', instancePath, 'Product V2 must use a domain-specific actuator.'));
        if (instance.capability_id === 'system_diagnostics' && instance.availability === 'active') diagnosticsCount += 1;
        if (instance.availability === 'planned') warnings.push(issue('PLANNED_INSTANCE', instancePath, `${instance.instance_id} is excluded from active runtime compilation.`));
        if (requiresEdgeContract && instance.availability === 'active') {
            lintEdgeCapabilityContract(capability, instancePath, errors);
        }

        for (const property of capability.properties || []) {
            const root = property.channel === 'diagnostic'
                ? `diagnostics.${instance.instance_id}`
                : `instances.${instance.instance_id}.${property.channel}`;
            const fullPath = `${root}.${property.id}`;
            if (propertyPaths.has(fullPath)) errors.push(issue('DUPLICATE_PROPERTY_PATH', instancePath, `Duplicate compiled property path ${fullPath}.`));
            propertyPaths.add(fullPath);
        }
    });

    if (diagnosticsCount !== 1) errors.push(issue('SYSTEM_DIAGNOSTICS_REQUIRED', `${path}.capability_instances`, 'Every Product needs exactly one active system_diagnostics instance.'));
    const policyIds = new Set();
    const priorities = new Set();
    for (const [index, policy] of (product.local_policies || []).entries()) {
        const policyPath = `${path}.local_policies[${index}]`;
        if (policyIds.has(policy.id)) errors.push(issue('DUPLICATE_POLICY', `${policyPath}.id`, `Duplicate local policy ${policy.id}.`));
        if (priorities.has(policy.priority)) errors.push(issue('DUPLICATE_POLICY_PRIORITY', `${policyPath}.priority`, `Duplicate local policy priority ${policy.priority}.`));
        policyIds.add(policy.id);
        priorities.add(policy.priority);
        if (policy.enforced_locally !== true) warnings.push(issue('NON_LOCAL_SAFETY_POLICY', policyPath, 'Product policies should remain enforceable while offline.'));
    }
}

function lintCatalog(catalog) {
    const errors = [];
    const warnings = [];

    if (!isPlainObject(catalog)) return { errors: [issue('INVALID_CATALOG', '$', 'Catalog must be an object.')], warnings };
    if (catalog.catalog_schema !== 'smarthome.catalog.v2') errors.push(issue('INVALID_CATALOG_SCHEMA', '$.catalog_schema', 'Expected smarthome.catalog.v2.'));
    if (catalog.schema_version !== 2) errors.push(issue('INVALID_SCHEMA_VERSION', '$.schema_version', 'Expected schema version 2.'));
    if (!Number.isInteger(catalog.catalog_revision) || catalog.catalog_revision < 1) errors.push(issue('INVALID_CATALOG_REVISION', '$.catalog_revision', 'Catalog revision must be positive.'));
    if (!['draft', 'published', 'deprecated'].includes(catalog.lifecycle)) errors.push(issue('INVALID_CATALOG_LIFECYCLE', '$.lifecycle', 'Catalog lifecycle must be draft, published or deprecated.'));

    const capabilities = Array.isArray(catalog.capabilities) ? catalog.capabilities : [];
    const products = Array.isArray(catalog.products) ? catalog.products : [];
    if (capabilities.length === 0) errors.push(issue('CAPABILITIES_REQUIRED', '$.capabilities', 'Catalog must contain capabilities.'));
    if (products.length === 0) errors.push(issue('PRODUCTS_REQUIRED', '$.products', 'Catalog must contain products.'));

    const capabilityIndex = new Map();
    capabilities.forEach((capability, index) => {
        const path = `$.capabilities[${index}]`;
        const key = `${capability.capability_id}@${capability.revision}`;
        if (capabilityIndex.has(key)) errors.push(issue('DUPLICATE_CAPABILITY_REVISION', path, `Duplicate capability revision ${key}.`));
        capabilityIndex.set(key, capability);
        lintCapability(capability, path, errors, warnings);
    });

    const productIndex = new Set();
    products.forEach((product, index) => {
        const path = `$.products[${index}]`;
        const key = `${product.product_id}@${product.catalog_revision}`;
        if (productIndex.has(key)) errors.push(issue('DUPLICATE_PRODUCT_REVISION', path, `Duplicate product revision ${key}.`));
        productIndex.add(key);
        lintProduct(product, path, capabilityIndex, errors, warnings);
    });

    return { errors, warnings };
}

function assertCatalogValid(catalog) {
    const result = lintCatalog(catalog);
    if (result.errors.length > 0) {
        const details = result.errors.map(item => `${item.code} at ${item.path}: ${item.message}`).join('\n');
        const error = new Error(`Product Catalog V2 validation failed:\n${details}`);
        error.issues = result.errors;
        throw error;
    }
    return result;
}

module.exports = {
    assertCatalogValid,
    lintCatalog,
    validateValue,
};
