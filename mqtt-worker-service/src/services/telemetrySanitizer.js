/**
 * mqtt-worker-service/src/services/telemetrySanitizer.js
 * 
 * Lớp dịch vụ lọc và chuẩn hóa dữ liệu Telemetry (Telemetry Sanitizer)
 * dựa trên định nghĩa cấu hình sản phẩm từ Catalog.
 */

const { validateValueAgainstSchema } = require('../../../shared/validation');
const { recordSanitizerStats } = require('../monitoring/metrics');

/**
 * @typedef {Object} ValidationSchema
 * @property {string} value_type - Kiểu dữ liệu (boolean, number, string, object)
 * @property {Object} [validation] - Các ràng buộc (min, max, max_length, enum, required)
 * @property {Object.<string, ValidationSchema>} [validation_versions] - Validation tùy chỉnh theo version
 */

/**
 * @typedef {Object} CompiledCommand
 * @property {string} capability_id - Capability ID chứa command
 * @property {Array<{name: string, value_type: string, validation?: Object}>} arguments - Arguments cấu hình
 */

/**
 * @typedef {Object} CompiledProduct
 * @property {string} _id - Product ID
 * @property {string} manufacturer - Nhà sản xuất
 * @property {string} model_name - Tên model
 * @property {string} display_name - Tên hiển thị
 * @property {string} connectivity - Phương thức kết nối
 * @property {string} category - Loại thiết bị
 * @property {Object} default_state - Trạng thái mặc định ban đầu
 * @property {Set<string>} allowedStateKeys - Tập hợp state keys được cho phép
 * @property {Set<string>} allowedDiagnosticKeys - Tập hợp diagnostic keys được cho phép
 * @property {Map<string, CompiledCommand>} allowedCommandActions - Map các commands được cho phép
 */

/**
 * @typedef {Object} TelemetrySanitizerResult
 * @property {Object} sanitizedState - Tập hợp trạng thái state hợp lệ
 * @property {Object} sanitizedDiagnostics - Tập hợp thông số diagnostics hợp lệ
 * @property {Array<{key: string, val: any, type: string, error: string}>} warnings - Danh sách cảnh báo lỗi validation
 */

class TelemetrySanitizer {
    constructor(logger) {
        this.logger = logger;
    }

    /**
     * Lọc và validate toàn bộ telemetry metrics dựa trên cấu hình template trong Catalog.
     * 
     * @param {Object} telemetry - Dữ liệu raw telemetry đã parse
     * @param {CompiledProduct} product - Bản ghi sản phẩm mẫu từ Catalog Cache
     * @param {string|null} firmwareVersion - Phiên bản firmware hiện tại của thiết bị
     * @returns {TelemetrySanitizerResult}
     */
    sanitize(telemetry, product, firmwareVersion) {
        const sanitizedState = {};
        const sanitizedDiagnostics = {};
        const warnings = [];

        const stats = {
            unknown_keys: 0,
            invalid_type: 0,
            out_of_range: 0
        };

        const allMetrics = { ...telemetry.metrics };
        if (telemetry.rssi !== undefined) allMetrics.rssi = telemetry.rssi;
        if (telemetry.battery !== undefined) allMetrics.battery = telemetry.battery;

        const stateSchemaMap = product.stateSchemaMap;
        const diagnosticSchemaMap = product.diagnosticSchemaMap;

        for (const [key, val] of Object.entries(allMetrics)) {
            if (stateSchemaMap && stateSchemaMap.has(key)) {
                const schema = stateSchemaMap.get(key);
                const res = validateValueAgainstSchema(val, schema, firmwareVersion);
                if (res.valid) {
                    sanitizedState[key] = val;
                } else {
                    this.updateStatsAndWarnings(key, val, 'state', res.error, stats, warnings);
                }
            } else if (diagnosticSchemaMap && diagnosticSchemaMap.has(key)) {
                const schema = diagnosticSchemaMap.get(key);
                const res = validateValueAgainstSchema(val, schema, firmwareVersion);
                if (res.valid) {
                    sanitizedDiagnostics[key] = val;
                } else {
                    this.updateStatsAndWarnings(key, val, 'diagnostic', res.error, stats, warnings);
                }
            } else {
                stats.unknown_keys++;
                warnings.push({
                    key,
                    val,
                    type: 'unknown',
                    error: 'Key is not defined in the catalog schema templates'
                });
            }
        }

        // Cập nhật thống kê vào monitoring metrics
        recordSanitizerStats(stats);

        return { sanitizedState, sanitizedDiagnostics, warnings };
    }

    /**
     * @private
     */
    updateStatsAndWarnings(key, val, type, errorMsg, stats, warnings) {
        if (errorMsg.includes('type')) {
            stats.invalid_type++;
        } else if (errorMsg.includes('minimum') || errorMsg.includes('maximum')) {
            stats.out_of_range++;
        }
        warnings.push({ key, val, type, error: errorMsg });
    }
}

module.exports = {
    TelemetrySanitizer
};
