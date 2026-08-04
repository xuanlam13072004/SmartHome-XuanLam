const assert = require('node:assert/strict');
const test = require('node:test');

const { CatalogCache } = require('./catalogCache');

const createDatabase = ({ capabilities, products }) => ({
    collection(name) {
        const documents = name === 'capabilities' ? capabilities : products;
        return {
            find() {
                return {
                    async toArray() {
                        return documents;
                    }
                };
            }
        };
    }
});

const silentLogger = {
    info() {},
    error() {}
};

test('compiled capability instances preserve product semantic metadata', async () => {
    const db = createDatabase({
        capabilities: [{
            _id: 'light_controller',
            name: 'Light Controller',
            state_properties: {
                power: { value_type: 'boolean' }
            },
            commands: []
        }],
        products: [{
            _id: 'product-light',
            ui_profile: 'room_light',
            ui_profile_version: 2,
            capabilities: [{
                capability_id: 'light_controller',
                instance: 'main_light',
                semantic_role: 'room_light',
                default_display_name: 'Đèn phòng khách',
                default_icon: 'lightbulb',
                display_order: 3
            }]
        }]
    });
    const cache = new CatalogCache(db, null, silentLogger);

    await cache.reload();

    const product = cache.getProduct('product-light');
    assert.equal(product.ui_profile, 'room_light');
    assert.equal(product.ui_profile_version, 2);
    const [instance] = product.capabilityInstances;
    assert.deepEqual(
        {
            semantic_role: instance.semantic_role,
            default_display_name: instance.default_display_name,
            default_icon: instance.default_icon,
            display_order: instance.display_order
        },
        {
            semantic_role: 'room_light',
            default_display_name: 'Đèn phòng khách',
            default_icon: 'lightbulb',
            display_order: 3
        }
    );
});

test('automatically appended diagnostics receive safe UI metadata and sort last', async () => {
    const db = createDatabase({
        capabilities: [
            {
                _id: 'switch',
                name: 'Switch',
                state_properties: {
                    power: { value_type: 'boolean' }
                },
                commands: []
            },
            {
                _id: 'system-diagnostics',
                name: 'System Diagnostics',
                state_properties: {},
                diagnostic_properties: {
                    rssi: { value_type: 'number' }
                },
                commands: []
            }
        ],
        products: [{
            _id: 'product-switch',
            capabilities: [{
                capability_id: 'switch',
                instance: 'main_switch',
                display_order: 1
            }]
        }]
    });
    const cache = new CatalogCache(db, null, silentLogger);

    await cache.reload();

    const diagnostics = cache
        .getProduct('product-switch')
        .capabilityInstances
        .find((instance) => instance.capability_id === 'system-diagnostics');

    assert.ok(diagnostics);
    assert.equal(diagnostics.semantic_role, 'system-diagnostics');
    assert.equal(diagnostics.default_display_name, 'System Diagnostics');
    assert.equal(diagnostics.default_icon, 'monitor_heart');
    assert.equal(diagnostics.display_order, Number.MAX_SAFE_INTEGER);
});
