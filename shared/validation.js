/**
 * shared/validation.js
 * 
 * Bộ validate dữ liệu dùng chung (Shared Validation Module) cho hệ thống SmartHome-XuanLam.
 * Dùng cho cả:
 * - API Gateway (validate command arguments gửi xuống thiết bị)
 * - MQTT Worker (validate telemetry metrics nhận được từ thiết bị)
 * 
 * Đảm bảo tính nhất quán 100% về quy tắc kiểm soát dữ liệu trên toàn hệ thống.
 */

/**
 * @typedef {Object} ValidationSchema
 * @property {string} value_type - Kiểu dữ liệu (boolean, number, string, object)
 * @property {Object} [validation] - Ràng buộc cơ bản (min, max, max_length, enum, required)
 * @property {Object.<string, ValidationSchema>} [validation_versions] - Ràng buộc riêng theo từng phiên bản
 */

/**
 * @typedef {Object} CompiledCommand
 * @property {string} capability_id - ID của capability chứa command
 * @property {Array<{name: string, value_type: string, validation?: Object}>} arguments - Các đối số của command
 */

/**
 * @typedef {Object} CompiledProduct
 * @property {string} _id - Product ID
 * @property {string} manufacturer - Nhà sản xuất
 * @property {string} model_name - Tên model
 * @property {string} display_name - Tên hiển thị
 * @property {string} connectivity - Wifi/zigbee...
 * @property {string} category - Danh mục sản phẩm
 * @property {Object} default_state - Trạng thái mặc định khởi tạo
 * @property {Set<string>} allowedStateKeys - Các khóa state được phép
 * @property {Set<string>} allowedDiagnosticKeys - Các khóa diagnostics được phép
 * @property {Map<string, CompiledCommand>} allowedCommandActions - Map các command được phép
 * @property {Object.<string, ValidationSchema>} stateSchemaMap - Map từ state key sang schema
 * @property {Object.<string, ValidationSchema>} diagnosticSchemaMap - Map từ diagnostics key sang schema
 */

/**
 * @typedef {Object} TelemetrySanitizerResult
 * @property {Object} sanitizedState - Trạng thái state đã lọc
 * @property {Object} sanitizedDiagnostics - Dữ liệu kỹ thuật đã lọc
 * @property {Array<{key: string, val: any, type: string, error: string}>} warnings - Cảnh báo validation lỗi
 */

/**
 * validateValueAgainstSchema: Kiểm tra một giá trị có khớp với đặc tả của capability hay không.
 * 
 * @param {any} value - Giá trị cần kiểm tra
 * @param {object} schema - Đặc tả schema của thuộc tính (từ capability)
 * @param {string|number} [schemaVersion] - Phiên bản schema của thiết bị để chọn luật tương ứng
 * @returns {object} { valid: boolean, error: string | null }
 */
function validateValueAgainstSchema(value, schema, schemaVersion = undefined) {
    if (!schema) {
        return { valid: false, error: 'Schema is undefined' };
    }

    const { value_type } = schema;
    let validation = schema.validation;

    // Hỗ trợ Validation Versioning: chọn tập luật tương ứng với phiên bản của thiết bị
    if (schemaVersion !== undefined && schema.validation_versions && schema.validation_versions[schemaVersion]) {
        validation = schema.validation_versions[schemaVersion];
    }

    // 1. Kiểm tra sự tồn tại (required)
    if (value === undefined || value === null) {
        if (validation && validation.required) {
            return { valid: false, error: 'Value is required' };
        }
        return { valid: true, error: null }; // Cho phép null/undefined nếu không bắt buộc
    }

    // 2. Validate kiểu dữ liệu chính (value_type)
    switch (value_type) {
        case 'boolean':
            if (typeof value !== 'boolean') {
                return { valid: false, error: `Expected type boolean, got ${typeof value}` };
            }
            break;

        case 'number':
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return { valid: false, error: `Expected type number, got ${typeof value}` };
            }
            // Kiểm tra ràng buộc của number
            if (validation) {
                if (validation.min !== undefined && value < validation.min) {
                    return { valid: false, error: `Value ${value} is less than minimum: ${validation.min}` };
                }
                if (validation.max !== undefined && value > validation.max) {
                    return { valid: false, error: `Value ${value} is greater than maximum: ${validation.max}` };
                }
            }
            break;

        case 'string':
            if (typeof value !== 'string') {
                return { valid: false, error: `Expected type string, got ${typeof value}` };
            }
            // Kiểm tra ràng buộc của string
            if (validation) {
                if (validation.max_length !== undefined && value.length > validation.max_length) {
                    return { valid: false, error: `String length ${value.length} exceeds max_length: ${validation.max_length}` };
                }
                if (validation.enum !== undefined && Array.isArray(validation.enum)) {
                    if (!validation.enum.includes(value)) {
                        return { valid: false, error: `Value "${value}" is not in allowed enum list: [${validation.enum.join(', ')}]` };
                    }
                }
            }
            break;

        case 'object':
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                return { valid: false, error: `Expected type object, got ${typeof value}` };
            }
            break;

        default:
            return { valid: false, error: `Unsupported value_type: ${value_type}` };
    }

    return { valid: true, error: null };
}

module.exports = {
    validateValueAgainstSchema
};
