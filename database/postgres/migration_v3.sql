-- ============================================================================
-- SmartHome-XuanLam Database Migration - Version 3
-- Goal: Clean Break - Drop 'role' and introduce 'product_id' & 'gateway_id'
-- ============================================================================

-- 1. Bổ sung cột product_id vào bảng factory_devices
ALTER TABLE factory_devices ADD COLUMN IF NOT EXISTS product_id VARCHAR(32) NOT NULL DEFAULT 'prod_smart_plug';

-- Cập nhật ánh xạ dữ liệu cũ sang product_id mới trong factory_devices
UPDATE factory_devices SET product_id = 'prod_smart_plug' WHERE role = 'smart_plug';
UPDATE factory_devices SET product_id = 'prod_rgb_light' WHERE role = 'rgb_light';
UPDATE factory_devices SET product_id = 'prod_switch_2_gang' WHERE role = 'switch_2_gang';

-- Xóa cột role cũ trong factory_devices
ALTER TABLE factory_devices DROP COLUMN IF EXISTS role;


-- 2. Bổ sung cột product_id và gateway_id vào bảng device_metadata
ALTER TABLE device_metadata ADD COLUMN IF NOT EXISTS product_id VARCHAR(32) NOT NULL DEFAULT 'prod_smart_plug';
ALTER TABLE device_metadata ADD COLUMN IF NOT EXISTS gateway_id VARCHAR(17) DEFAULT NULL;

-- Cập nhật ánh xạ dữ liệu cũ sang product_id mới trong device_metadata
UPDATE device_metadata SET product_id = 'prod_smart_plug' WHERE role = 'smart_plug';
UPDATE device_metadata SET product_id = 'prod_rgb_light' WHERE role = 'rgb_light';
UPDATE device_metadata SET product_id = 'prod_switch_2_gang' WHERE role = 'switch_2_gang';

-- Xóa cột role cũ và check constraint trong device_metadata
ALTER TABLE device_metadata DROP CONSTRAINT IF EXISTS device_metadata_role_check;
ALTER TABLE device_metadata DROP COLUMN IF EXISTS role;
