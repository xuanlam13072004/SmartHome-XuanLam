'use strict';

const { validateValueAgainstSchema } = require('../../../shared/validation');
const { recordSanitizerStats } = require('../monitoring/metrics');

class TelemetrySanitizer {
    constructor(logger) {
        this.logger = logger;
    }

    sanitize(telemetry, product) {
        const instances = {};
        const diagnostics = {};
        const warnings = [];
        const stats = { unknown_keys: 0, invalid_type: 0, out_of_range: 0 };
        const active = new Map(
            product.capability_instances.map(instance => [instance.instance_id, instance]),
        );

        for (const [instanceId, envelope] of Object.entries(telemetry.instances || {})) {
            const definition = active.get(instanceId);
            if (!definition || !envelope || typeof envelope !== 'object') {
                this.warn(instanceId, envelope, 'unknown', 'Unknown capability instance', stats, warnings);
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(envelope, 'desired')) {
                this.warn(
                    `${instanceId}.desired`,
                    envelope.desired,
                    'authority',
                    'Device telemetry cannot write backend desired state',
                    stats,
                    warnings,
                );
            }
            const reportedSchemas = new Map(
                definition.properties
                    .filter(property => property.channel === 'reported')
                    .map(property => [property.id, property]),
            );
            const accepted = {};
            for (const [propertyId, value] of Object.entries(envelope.reported || {})) {
                const schema = reportedSchemas.get(propertyId);
                if (!schema) {
                    this.warn(
                        `instances.${instanceId}.reported.${propertyId}`,
                        value,
                        'unknown',
                        'Unknown reported property',
                        stats,
                        warnings,
                    );
                    continue;
                }
                if (schema.state_authority === 'product_catalog') {
                    this.warn(
                        `instances.${instanceId}.reported.${propertyId}`,
                        value,
                        'authority',
                        'Device telemetry cannot write Product Catalog constants',
                        stats,
                        warnings,
                    );
                    continue;
                }
                const validation = validateValueAgainstSchema(value, schema, { required: true });
                if (validation.valid) accepted[propertyId] = value;
                else this.warn(
                    `instances.${instanceId}.reported.${propertyId}`,
                    value,
                    'invalid',
                    validation.error,
                    stats,
                    warnings,
                );
            }
            if (Object.keys(accepted).length > 0) instances[instanceId] = { reported: accepted };
        }

        for (const [instanceId, values] of Object.entries(telemetry.diagnostics || {})) {
            const definition = active.get(instanceId);
            if (!definition || !values || typeof values !== 'object') {
                this.warn(instanceId, values, 'unknown', 'Unknown diagnostic instance', stats, warnings);
                continue;
            }
            const diagnosticSchemas = new Map(
                definition.properties
                    .filter(property => property.channel === 'diagnostic')
                    .map(property => [property.id, property]),
            );
            const accepted = {};
            for (const [propertyId, value] of Object.entries(values)) {
                const schema = diagnosticSchemas.get(propertyId);
                if (!schema) {
                    this.warn(
                        `diagnostics.${instanceId}.${propertyId}`,
                        value,
                        'unknown',
                        'Unknown diagnostic property',
                        stats,
                        warnings,
                    );
                    continue;
                }
                if (schema.state_authority === 'product_catalog') {
                    this.warn(
                        `diagnostics.${instanceId}.${propertyId}`,
                        value,
                        'authority',
                        'Device telemetry cannot write Product Catalog constants',
                        stats,
                        warnings,
                    );
                    continue;
                }
                const validation = validateValueAgainstSchema(value, schema, { required: true });
                if (validation.valid) accepted[propertyId] = value;
                else this.warn(
                    `diagnostics.${instanceId}.${propertyId}`,
                    value,
                    'invalid',
                    validation.error,
                    stats,
                    warnings,
                );
            }
            if (Object.keys(accepted).length > 0) diagnostics[instanceId] = accepted;
        }

        recordSanitizerStats(stats);
        return { instances, diagnostics, warnings };
    }

    warn(key, value, type, error, stats, warnings) {
        if (type === 'unknown' || type === 'authority') stats.unknown_keys += 1;
        else if (String(error).includes('minimum') || String(error).includes('maximum')) {
            stats.out_of_range += 1;
        } else stats.invalid_type += 1;
        warnings.push({ key, value, type, error });
    }
}

module.exports = { TelemetrySanitizer };
