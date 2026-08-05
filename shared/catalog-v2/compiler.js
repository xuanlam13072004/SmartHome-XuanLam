'use strict';

const { assertCatalogValid } = require('./lint');

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function propertyPath(instanceId, property) {
    if (property.channel === 'diagnostic') return `diagnostics.${instanceId}.${property.id}`;
    return `instances.${instanceId}.${property.channel}.${property.id}`;
}

function setDefault(target, instanceId, property) {
    if (!Object.prototype.hasOwnProperty.call(property, 'default')) return;
    const value = clone(property.default);
    if (property.channel === 'diagnostic') {
        target.diagnostics[instanceId] ||= {};
        target.diagnostics[instanceId][property.id] = value;
        return;
    }

    target.instances[instanceId] ||= { reported: {}, desired: {} };
    target.instances[instanceId][property.channel][property.id] = value;
}

function compileCapabilityInstance(instance, capability) {
    const propertyOverrides = instance.property_overrides || {};
    const properties = capability.properties.map(property => {
        const override = propertyOverrides[property.id] || {};
        return {
            ...clone(property),
            ...clone(override),
            path: propertyPath(instance.instance_id, property),
        };
    });

    return {
        instance_id: instance.instance_id,
        capability_id: capability.capability_id,
        capability_revision: capability.revision,
        semantic_role: instance.semantic_role,
        availability: instance.availability,
        presentation: clone(instance.presentation),
        runtime: clone(capability.runtime),
        properties,
        operations: clone(capability.operations),
        events: clone(capability.events),
        resources: clone(capability.resources),
        credentials: clone(capability.credentials),
    };
}

function compileProduct(product, capabilityIndex) {
    // These are firmware/simulator boot defaults only. They must never be used
    // by Gateway claim flow to seed a reported device shadow.
    const firmwareDefaultState = {
        schema: 'device.state.v2',
        state_version: 0,
        instances: {},
        diagnostics: {},
    };
    const propertySchemas = {};
    const operations = {};
    const events = {};
    const resources = {};
    const credentials = {};
    const permissions = new Set(['device.view']);
    const activeInstances = [];
    const plannedInstances = [];

    for (const instance of product.capability_instances) {
        const key = `${instance.capability_id}@${instance.capability_revision}`;
        const capability = capabilityIndex.get(key);
        const compiledInstance = compileCapabilityInstance(instance, capability);

        if (instance.availability === 'planned') {
            plannedInstances.push(compiledInstance);
            continue;
        }

        activeInstances.push(compiledInstance);
        for (const property of compiledInstance.properties) {
            propertySchemas[property.path] = clone(property);
            setDefault(firmwareDefaultState, instance.instance_id, property);
        }
        for (const operation of compiledInstance.operations) {
            operations[`${instance.instance_id}.${operation.id}`] = {
                ...clone(operation),
                instance_id: instance.instance_id,
                capability_id: instance.capability_id,
            };
            permissions.add(operation.permission);
        }
        for (const event of compiledInstance.events) {
            events[`${instance.instance_id}.${event.id}`] = {
                ...clone(event),
                instance_id: instance.instance_id,
                capability_id: instance.capability_id,
            };
        }
        for (const resource of compiledInstance.resources) {
            resources[`${instance.instance_id}.${resource.id}`] = {
                ...clone(resource),
                instance_id: instance.instance_id,
                capability_id: instance.capability_id,
            };
            permissions.add(resource.permission);
        }
        for (const credential of compiledInstance.credentials) {
            credentials[`${instance.instance_id}.${credential.id}`] = {
                ...clone(credential),
                instance_id: instance.instance_id,
                capability_id: instance.capability_id,
            };
            permissions.add(credential.permission);
        }
    }

    return {
        schema: 'compiled.product.v2',
        schema_version: 2,
        product_id: product.product_id,
        ui_profile: product.ui_profile,
        ui_profile_version: product.ui_profile_version,
        catalog_revision: product.catalog_revision,
        lifecycle: product.lifecycle,
        contract_maturity: product.contract_maturity || 'draft',
        manufacturer: product.manufacturer,
        model_name: product.model_name,
        category: product.category,
        description: product.description,
        firmware_compatibility: clone(product.firmware_compatibility),
        connectivity_profiles: clone(product.connectivity_profiles),
        behavior_profile: product.behavior_profile,
        presentation: clone(product.presentation),
        capability_instances: activeInstances,
        planned_capability_instances: plannedInstances,
        local_policies: clone(product.local_policies),
        firmware_default_state: firmwareDefaultState,
        reported_state_seed_policy: 'device_report_only',
        property_schemas: propertySchemas,
        operations,
        events,
        resources,
        credentials,
        permissions: [...permissions].sort(),
    };
}

function compileCatalog(catalog) {
    const lint = assertCatalogValid(catalog);
    const capabilityIndex = new Map(
        catalog.capabilities.map(capability => [`${capability.capability_id}@${capability.revision}`, capability]),
    );
    const products = catalog.products.map(product => compileProduct(product, capabilityIndex));

    return {
        catalog_schema: 'smarthome.compiled-catalog.v2',
        schema_version: 2,
        catalog_revision: catalog.catalog_revision,
        lifecycle: catalog.lifecycle,
        warnings: clone(lint.warnings),
        products,
        product_index: Object.fromEntries(products.map(product => [product.product_id, product])),
    };
}

module.exports = {
    compileCatalog,
    compileProduct,
    propertyPath,
};
