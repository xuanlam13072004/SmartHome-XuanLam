-- ============================================================================
-- SmartHome-XuanLam Database Migration - Version 3
-- Goal: Clean Break - Drop 'role' and introduce 'product_id' & 'gateway_id'
-- ============================================================================

SET search_path TO public;

-- 1. Bổ sung cột product_id vào bảng factory_devices
ALTER TABLE factory_devices ADD COLUMN IF NOT EXISTS product_id VARCHAR(32) NOT NULL DEFAULT 'prod_smart_plug';

-- Cập nhật ánh xạ dữ liệu cũ sang product_id mới trong factory_devices (chỉ khi cột role còn tồn tại)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='factory_devices' AND column_name='role') THEN
    EXECUTE 'UPDATE factory_devices SET product_id = ''prod_smart_plug'' WHERE role = ''smart_plug''';
    EXECUTE 'UPDATE factory_devices SET product_id = ''prod_rgb_light'' WHERE role = ''rgb_light''';
    EXECUTE 'UPDATE factory_devices SET product_id = ''prod_switch_2_gang'' WHERE role = ''switch_2_gang''';
    EXECUTE 'ALTER TABLE factory_devices DROP COLUMN role';
  END IF;
END $$;


-- 2. Bổ sung cột product_id và gateway_id vào bảng device_metadata
ALTER TABLE device_metadata ADD COLUMN IF NOT EXISTS product_id VARCHAR(32) NOT NULL DEFAULT 'prod_smart_plug';
ALTER TABLE device_metadata ADD COLUMN IF NOT EXISTS gateway_id VARCHAR(17) DEFAULT NULL;

-- Cập nhật ánh xạ dữ liệu cũ sang product_id mới trong device_metadata (chỉ khi cột role còn tồn tại)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='device_metadata' AND column_name='role') THEN
    EXECUTE 'UPDATE device_metadata SET product_id = ''prod_smart_plug'' WHERE role = ''smart_plug''';
    EXECUTE 'UPDATE device_metadata SET product_id = ''prod_rgb_light'' WHERE role = ''rgb_light''';
    EXECUTE 'UPDATE device_metadata SET product_id = ''prod_switch_2_gang'' WHERE role = ''switch_2_gang''';
  END IF;
END $$;

-- Xóa cột role cũ và check constraint trong device_metadata
ALTER TABLE device_metadata DROP CONSTRAINT IF EXISTS device_metadata_role_check;
ALTER TABLE device_metadata DROP COLUMN IF EXISTS role;
