import { Db } from 'mongodb';
import Redis from 'ioredis';
import { FastifyLoggerInstance } from 'fastify';
import { REDIS_CHANNELS } from '../../../../shared/constants';

export interface CompiledCommandArg {
    name: string;
    value_type: string;
    validation?: Record<string, any>;
    validation_ref?: string;
}

export interface CompiledCapabilityInstance {
    capability_id: string;
    instance: string;
    value_type: string;
    validation: Record<string, any>;
    state_properties: Record<string, any>;
    diagnostic_properties: Record<string, any>;
    commands: any[];
}

export interface CompiledCommand {
    capability_id: string;
    instance: string;
    arguments: CompiledCommandArg[];
}

export interface CompiledProduct {
    _id: string;
    manufacturer: string;
    model_name: string;
    display_name: string;
    firmware_family: string;
    connectivity: string;
    category: string;
    icon: string;
    description: string;
    default_state: Record<string, any>;
    allowedStateKeys: Set<string>;
    allowedDiagnosticKeys: Set<string>;
    allowedCommandActions: Map<string, Map<string, CompiledCommand>>;
    catalogVersion: number;
}

function deepFreeze(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (obj instanceof Map) {
        for (const [key, value] of obj.entries()) {
            deepFreeze(key);
            deepFreeze(value);
        }
        obj.set = () => { throw new Error('ReadOnlyMap: set() is disabled'); };
        obj.delete = () => { throw new Error('ReadOnlyMap: delete() is disabled'); };
        obj.clear = () => { throw new Error('ReadOnlyMap: clear() is disabled'); };
        Object.freeze(obj);
        return obj;
    }

    if (obj instanceof Set) {
        for (const value of obj.values()) {
            deepFreeze(value);
        }
        obj.add = () => { throw new Error('ReadOnlySet: add() is disabled'); };
        obj.delete = () => { throw new Error('ReadOnlySet: delete() is disabled'); };
        obj.clear = () => { throw new Error('ReadOnlySet: clear() is disabled'); };
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

function hasCircularDependency(capMap: Map<string, any>): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();

    function detect(capId: string): boolean {
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

export class CatalogCache {
    private db: Db;
    private redis: Redis;
    private log: FastifyLoggerInstance;
    private products = new Map<string, CompiledProduct>();
    private capabilities = new Map<string, any>();
    private isInitialized = false;
    public catalogVersion = 0;

    constructor(db: Db, redis: Redis, log: FastifyLoggerInstance) {
        this.db = db;
        this.redis = redis;
        this.log = log;
    }

    /**
     * Khởi động Catalog Cache
     */
    async start() {
        if (this.isInitialized) return;
        
        this.log.info('Initializing Catalog Cache...');
        await this.reload();
        
        // Đăng ký lắng nghe sự kiện hot-reload qua Redis Pub/Sub bằng constants
        try {
            const redisSub = this.redis.duplicate();
            await redisSub.connect().catch(() => {});
            
            await redisSub.subscribe(REDIS_CHANNELS.CATALOG_UPDATED);
            redisSub.on('message', async (channel, message) => {
                if (channel === REDIS_CHANNELS.CATALOG_UPDATED) {
                    this.log.info({ message }, 'Received catalog:updated event via Redis Pub/Sub, reloading cache...');
                    await this.reload().catch((err) => {
                        this.log.error(err, 'Failed to hot-reload Catalog Cache');
                    });
                }
            });
            
            this.log.info(`Catalog Cache: Subscribed to channel: ${REDIS_CHANNELS.CATALOG_UPDATED}`);
        } catch (err) {
            this.log.error(err, 'Failed to setup Redis Pub/Sub subscriber for Catalog Cache');
        }

        // Thiết lập tự động làm mới dự phòng (Periodic Fallback Sync) mỗi 5 phút
        setInterval(async () => {
            this.log.info('Catalog Cache: Running periodic background synchronization...');
            await this.reload().catch((err) => {
                this.log.error(err, 'Catalog Cache: Periodic background synchronization failed');
            });
        }, 300000);

        this.isInitialized = true;
        this.log.info('Catalog Cache initialized successfully.');
    }

    /**
     * Tải lại toàn bộ dữ liệu từ MongoDB và thực hiện biên dịch sang RAM Cache với các check an toàn
     */
    async reload() {
        this.log.info('Catalog Cache: Fetching latest products and capabilities from MongoDB...');
        
        // 1. Load capabilities
        const rawCapabilities = await this.db.collection('capabilities').find({}).toArray();
        const capMap = new Map<string, any>();
        for (const cap of rawCapabilities) {
            capMap.set(cap._id.toString(), cap);
        }

        // Integrity Check: Phát hiện Circular Dependency
        if (hasCircularDependency(capMap)) {
            this.log.error('Integrity Check Failed: Circular dependency detected in capabilities! Catalog reload aborted.');
            throw new Error('Circular dependency detected in capabilities');
        }

        // 2. Load products và compile
        const rawProducts = await this.db.collection('products').find({}).toArray();
        const prodMap = new Map<string, CompiledProduct>();
        const nextVersion = this.catalogVersion + 1;

        for (const prod of rawProducts) {
            const allowedStateKeys = new Set<string>();
            const allowedDiagnosticKeys = new Set<string>();
            const allowedCommandActions = new Map<string, Map<string, CompiledCommand>>();

            // Duyệt danh sách capability liên kết trong Product
            const capabilitiesList = Array.isArray(prod.capabilities) ? [...prod.capabilities] : [];
            if (!capabilitiesList.some(c => c.capability_id === 'system-diagnostics') && capMap.has('system-diagnostics')) {
                capabilitiesList.push({ capability_id: 'system-diagnostics' });
            }

            const capInstances: CompiledCapabilityInstance[] = [];

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
                let state_properties: Record<string, any> = {};
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

                let diagnostic_properties: Record<string, any> = {};
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
                for (const key of Object.keys(capInst.state_properties)) {
                    allowedStateKeys.add(key);
                }

                // 2. Biên dịch Diagnostic Keys
                for (const key of Object.keys(capInst.diagnostic_properties)) {
                    allowedDiagnosticKeys.add(key);
                }

                // 3. Biên dịch Commands
                for (const cmd of capInst.commands) {
                    let instancesMap = allowedCommandActions.get(cmd.action);
                    if (!instancesMap) {
                        instancesMap = new Map<string, CompiledCommand>();
                        allowedCommandActions.set(cmd.action, instancesMap);
                    }

                    if (instancesMap.has(capInst.instance)) {
                        this.log.error(
                            { product_id: prod._id, action: cmd.action, instance: capInst.instance },
                            'Integrity Check Failed: Duplicated instance for command action within the same product template'
                        );
                        throw new Error(`Duplicated instance '${capInst.instance}' for action '${cmd.action}'`);
                    }

                    const compiledArgs: CompiledCommandArg[] = [];
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
                                        this.log.warn({ action: cmd.action, ref: arg.validation_ref }, 'Command argument references missing state property');
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
                catalogVersion: nextVersion
            });
        }

        // Đóng băng sâu (Deep Freeze) bảo mật
        deepFreeze(capMap);
        deepFreeze(prodMap);

        // Atomic Swap Reference
        this.capabilities = capMap;
        this.products = prodMap;
        this.catalogVersion = nextVersion;

        this.log.info(
            { version: this.catalogVersion, products: this.products.size, capabilities: this.capabilities.size },
            'Catalog Cache: Atomic swap successful. Catalog version incremented.'
        );
    }

    /**
     * Lấy cấu hình Product đã biên dịch
     */
    getProduct(productId: string): CompiledProduct | undefined {
        return this.products.get(productId);
    }

    /**
     * Lấy danh sách tất cả các Product
     */
    getAllProducts(): CompiledProduct[] {
        return Array.from(this.products.values());
    }

    /**
     * Lấy cấu hình Capability gốc
     */
    getCapability(capabilityId: string): any {
        return this.capabilities.get(capabilityId);
    }
}
