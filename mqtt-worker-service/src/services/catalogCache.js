const { validateValueAgainstSchema } = require('../../../shared/validation');
const { REDIS_CHANNELS } = require('../../../shared/constants');
const { recordCatalogReload } = require('../monitoring/metrics');

/**
 * deepFreeze: Đóng băng sâu (Deep Freeze) một đối tượng bao gồm cả Map, Set đệ quy
 * để đảm bảo tính bất biến (immutability) hoàn toàn tại runtime.
 */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (obj instanceof Map) {
        for (const [key, value] of obj.entries()) {
            deepFreeze(key);
            deepFreeze(value);
        }
        obj.set = function() { throw new Error('ReadOnlyMap: set() is disabled'); };
        obj.delete = function() { throw new Error('ReadOnlyMap: delete() is disabled'); };
        obj.clear = function() { throw new Error('ReadOnlyMap: clear() is disabled'); };
        Object.freeze(obj);
        return obj;
    }

    if (obj instanceof Set) {
        for (const value of obj.values()) {
            deepFreeze(value);
        }
        obj.add = function() { throw new Error('ReadOnlySet: add() is disabled'); };
        obj.delete = function() { throw new Error('ReadOnlySet: delete() is disabled'); };
        obj.clear = function() { throw new Error('ReadOnlySet: clear() is disabled'); };
        Object.freeze(obj);
        return obj;
    }

    Object.freeze(obj);
    Object.getOwnPropertyNames(obj).forEach((prop) => {
        if (Object.prototype.hasOwnProperty.call(obj, prop)
            && obj[prop] !== null
            && (typeof obj[prop] === 'object' || typeof obj[prop] === 'function')
            && !Object.isFrozen(obj[prop])
        ) {
            deepFreeze(obj[prop]);
        }
    });
    return obj;
}

/**
 * hasCircularDependency: Phát hiện chu kỳ phụ thuộc của các Capability
 */
function hasCircularDependency(capMap) {
    const visited = new Set();
    const stack = new Set();

    function detect(capId) {
        if (stack.has(capId)) return true;
        if (visited.has(capId)) return false;

        visited.add(capId);
        stack.add(capId);

        const cap = capMap.get(capId);
        if (cap && Array.isArray(cap.depends_on)) {
            for (const depId of cap.depends_on) {
                if (detect(depId.toString())) return true;
            }
        }

        stack.delete(capId);
        return false;
    }

    for (const capId of capMap.keys()) {
        if (detect(capId)) return true;
    }
    return false;
}

class CatalogCache {
    constructor(db, redis, log) {
        this.db = db;
        this.redis = redis;
        this.log = log;
        this.products = new Map();
        this.capabilities = new Map();
        this.isInitialized = false;
        this.catalogVersion = 0;
    }

    async start() {
        if (this.isInitialized) return;

        this.log.info('Initializing Worker Catalog Cache...');
        await this.reload();

        // Đăng ký hot-reload qua Redis Pub/Sub sử dụng shared constants
        try {
            const redisSub = this.redis.duplicate();
            await redisSub.connect().catch(() => {});

            await redisSub.subscribe(REDIS_CHANNELS.CATALOG_UPDATED);
            redisSub.on('message', async (channel, message) => {
                if (channel === REDIS_CHANNELS.CATALOG_UPDATED) {
                    this.log.info({ message }, 'Worker: Received catalog:updated via Redis Pub/Sub, reloading...');
                    await this.reload().catch((err) => {
                        this.log.error(err, 'Worker: Failed to hot-reload Catalog Cache');
                    });
                }
            });
            this.log.info(`Worker Catalog Cache: Subscribed to channel: ${REDIS_CHANNELS.CATALOG_UPDATED}`);
        } catch (err) {
            this.log.error(err, 'Worker: Failed to setup Redis Pub/Sub subscriber for Catalog Cache');
        }

        // Quét đồng bộ định kỳ 5 phút làm dự phòng
        setInterval(async () => {
            this.log.info('Worker Catalog Cache: Running periodic background synchronization...');
            await this.reload().catch((err) => {
                this.log.error(err, 'Worker Catalog Cache: Periodic background synchronization failed');
            });
        }, 300000);

        this.isInitialized = true;
        this.log.info('Worker Catalog Cache initialized successfully.');
    }

    /**
     * Tải và biên dịch catalog templates từ MongoDB, thực hiện Integrity Validation
     * và đổi reference atomically nếu thành công hoàn toàn.
     */
    async reload() {
        this.log.info('Worker Catalog Cache: Fetching latest products and capabilities from MongoDB...');

        // 1. Tải capabilities
        const rawCapabilities = await this.db.collection('capabilities').find({}).toArray();
        const capMap = new Map();
        for (const cap of rawCapabilities) {
            capMap.set(cap._id.toString(), cap);
        }

        // Integrity Check: Kiểm tra Circular Dependency
        if (hasCircularDependency(capMap)) {
            this.log.error('Integrity Check Failed: Circular dependency detected in capabilities! Catalog reload aborted.');
            throw new Error('Circular dependency detected in capabilities');
        }

        // 2. Tải products và compile
        const rawProducts = await this.db.collection('products').find({}).toArray();
        const prodMap = new Map();
        const nextVersion = this.catalogVersion + 1;

        for (const prod of rawProducts) {
            const allowedStateKeys = new Set();
            const allowedDiagnosticKeys = new Set();
            const allowedCommandActions = new Map();
            const stateSchemaMap = new Map();
            const diagnosticSchemaMap = new Map();

            // Duyệt danh sách capability liên kết trong Product
            const capabilitiesList = Array.isArray(prod.capabilities) ? [...prod.capabilities] : [];
            if (!capabilitiesList.some(c => c.capability_id === 'system-diagnostics') && capMap.has('system-diagnostics')) {
                capabilitiesList.push({ capability_id: 'system-diagnostics' });
            }

            const capInstances = [];

            for (const prodCap of capabilitiesList) {
                const cap = capMap.get(prodCap.capability_id);
                if (!cap) {
                    this.log.error({ product_id: prod._id, capability_id: prodCap.capability_id }, 'Integrity Check Failed: Product references missing capability');
                    throw new Error(`Capability not found: ${prodCap.capability_id}`);
                }

                // Bắt buộc mọi capability trong products.json phải có instance
                let instanceId = prodCap.instance;
                if (!instanceId) {
                    if (prodCap.capability_id === 'system-diagnostics') {
                        instanceId = 'diagnostics';
                    } else {
                        this.log.error({ product_id: prod._id, capability_id: prodCap.capability_id }, 'Integrity Check Failed: Capability linkage is missing mandatory instance field');
                        throw new Error(`Instance field is required for capability ${prodCap.capability_id} in product ${prod._id}`);
                    }
                }

                // Xây dựng state_properties và diagnostic_properties của instance
                let state_properties = {};
                if (cap.state_properties) {
                    state_properties = { ...cap.state_properties };
                } else if (prodCap.state_key) {
                    state_properties = {
                        [prodCap.state_key]: {
                            value_type: cap.value_type,
                            validation: cap.validation
                        }
                    };
                }

                let diagnostic_properties = {};
                if (cap.diagnostic_properties) {
                    diagnostic_properties = { ...cap.diagnostic_properties };
                } else if (prodCap.diagnostic_key) {
                    diagnostic_properties = {
                        [prodCap.diagnostic_key]: {
                            value_type: cap.value_type,
                            validation: cap.validation
                        }
                    };
                }

                // Check overlap
                const stateKeys = Object.keys(state_properties);
                const diagKeys = Object.keys(diagnostic_properties);
                const intersection = stateKeys.filter(k => diagKeys.includes(k));
                if (intersection.length > 0) {
                    this.log.error({ capability_id: cap._id, intersection }, 'Integrity Check Failed: Overlapping keys found between state and diagnostics properties');
                    throw new Error(`Overlapping keys in capability: ${cap._id}`);
                }

                capInstances.push({
                    capability_id: prodCap.capability_id,
                    instance: instanceId,
                    value_type: cap.value_type || '',
                    validation: cap.validation || {},
                    state_properties,
                    diagnostic_properties,
                    commands: cap.commands || []
                });
            }

            // Biên dịch các Registry từ mô hình trung tâm CompiledCapabilityInstance
            for (const capInst of capInstances) {
                // 1. Biên dịch State Keys
                for (const [key, prop] of Object.entries(capInst.state_properties)) {
                    allowedStateKeys.add(key);
                    stateSchemaMap.set(key, prop);
                }

                // 2. Biên dịch Diagnostic Keys
                for (const [key, prop] of Object.entries(capInst.diagnostic_properties)) {
                    allowedDiagnosticKeys.add(key);
                    diagnosticSchemaMap.set(key, prop);
                }

                // 3. Biên dịch Commands
                for (const cmd of capInst.commands) {
                    let instancesMap = allowedCommandActions.get(cmd.action);
                    if (!instancesMap) {
                        instancesMap = new Map();
                        allowedCommandActions.set(cmd.action, instancesMap);
                    }

                    if (instancesMap.has(capInst.instance)) {
                        this.log.error(
                            { product_id: prod._id, action: cmd.action, instance: capInst.instance },
                            'Integrity Check Failed: Duplicated instance for command action within the same product template'
                        );
                        throw new Error(`Duplicated instance '${capInst.instance}' for action '${cmd.action}'`);
                    }

                    const compiledArgs = [];
                    if (Array.isArray(cmd.arguments)) {
                        for (const arg of cmd.arguments) {
                            if (typeof arg === 'string') {
                                compiledArgs.push({
                                    name: arg,
                                    value_type: capInst.value_type,
                                    validation: capInst.validation
                                });
                            } else if (arg && typeof arg === 'object') {
                                if (arg.validation_ref) {
                                    const stateProp = capInst.state_properties[arg.validation_ref];
                                    if (stateProp) {
                                        compiledArgs.push({
                                            name: arg.name,
                                            value_type: stateProp.value_type,
                                            validation: { ...stateProp.validation, ...arg.validation }
                                        });
                                    } else {
                                        compiledArgs.push(arg);
                                    }
                                } else {
                                    compiledArgs.push(arg);
                                }
                            }
                        }
                    }

                    instancesMap.set(capInst.instance, {
                        capability_id: capInst.capability_id,
                        instance: capInst.instance,
                        arguments: compiledArgs
                    });
                }
            }

            prodMap.set(prod._id.toString(), {
                _id: prod._id.toString(),
                manufacturer: prod.manufacturer || 'Unknown',
                model_name: prod.model_name || 'Unknown',
                display_name: prod.display_name || prod.model_name || 'Unknown',
                firmware_family: prod.firmware_family || 'generic',
                connectivity: prod.connectivity || 'wifi',
                category: prod.category || 'generic',
                icon: prod.icon || 'device',
                description: prod.description || '',
                default_state: prod.default_state || {},
                allowedStateKeys,
                allowedDiagnosticKeys,
                allowedCommandActions,
                stateSchemaMap,
                diagnosticSchemaMap,
                catalogVersion: nextVersion
            });
        }

        // Đóng băng sâu (Deep Freeze) toàn bộ dữ liệu Catalog trước khi swap
        deepFreeze(capMap);
        deepFreeze(prodMap);

        // Atomic Swap Reference
        this.capabilities = capMap;
        this.products = prodMap;
        this.catalogVersion = nextVersion;

        try {
            recordCatalogReload();
        } catch (mErr) {
            // Ignore if metrics not fully initialized
        }

        this.log.info(
            { version: this.catalogVersion, products: this.products.size, capabilities: this.capabilities.size },
            'Worker Catalog Cache: Atomic swap successful. Catalog version incremented.'
        );
    }

    getProduct(productId) {
        return this.products.get(productId);
    }
}

module.exports = {
    CatalogCache
};
