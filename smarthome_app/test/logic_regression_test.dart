import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/utils/app_error_mapper.dart';
import 'package:smarthome_app/data/datasources/remote/device_remote_data_source.dart';
import 'package:smarthome_app/data/models/dto/device_dto.dart';
import 'package:smarthome_app/data/models/dto/product_dto.dart';
import 'package:smarthome_app/domain/mappers/capability_assembler.dart';
import 'package:smarthome_app/domain/mappers/product_mapper.dart';
import 'package:smarthome_app/domain/models/ws_events.dart';
import 'package:smarthome_app/features/dashboard/models/capability_model.dart';
import 'package:smarthome_app/features/dashboard/repositories/device_repository.dart';

class _RecordingRemoteDataSource implements IDeviceRemoteDataSource {
  Map<String, dynamic>? lastOperation;
  String? lastReauthToken;

  @override
  Future<Map<String, dynamic>> createOperation(
    String mac,
    String instance,
    String operationName,
    Map<String, dynamic> input, {
    int? expectedStateVersion,
    String? idempotencyKey,
    String? reauthToken,
  }) async {
    lastOperation = {
      'mac': mac,
      'instance_id': instance,
      'operation_name': operationName,
      'input': input,
      'expected_state_version': expectedStateVersion,
      'idempotency_key': idempotencyKey,
    };
    lastReauthToken = reauthToken;
    return {'success': true};
  }

  @override
  Future<Map<String, dynamic>> createResourceSession(
    String mac,
    String instanceId,
    String resourceId, {
    String? reauthToken,
  }) async =>
      {'status': 'ready'};

  @override
  Future<Map<String, dynamic>> replaceCredential(
    String mac,
    String instanceId,
    String credentialName,
    String material, {
    String? label,
    String? reauthToken,
  }) async =>
      {'status': 'queued'};

  @override
  Future<List<DeviceDto>> getDevices() async => [];

  @override
  Future<List<ProductDto>> getProducts() async => [];

  @override
  Future<DeviceDto> claimDevice(String mac, String secretKey, {String? name}) =>
      throw UnsupportedError('Not used');

  @override
  Future<DeviceDto> updateDeviceName(String mac, String name) =>
      throw UnsupportedError('Not used');

  @override
  Future<void> unpairDevice(String mac) async {}
}

Map<String, dynamic> _productJson() => {
      'product_id': 'prod_entrance_controller',
      'catalog_revision': 3,
      'ui_profile': 'entrance_controller',
      'ui_profile_version': 1,
      'manufacturer': 'SmartHome XuanLam Ltd.',
      'model_name': 'Entrance Controller',
      'category': 'security',
      'firmware_compatibility': {
        'family': 'entrance_controller',
        'minimum_version': '2.0.0',
      },
      'connectivity_profiles': ['wifi', 'hub_node'],
      'presentation': {
        'display_name': 'Bộ Kiểm Soát Cửa Chính',
        'icon': 'door_front',
        'description': 'Điều khiển cửa',
      },
      'firmware_default_state': {
        'instances': {
          'main_lock': {
            'reported': {'lock_state': 'locked'},
          },
        },
      },
      'capability_instances': [
        {
          'capability_id': 'door_lock',
          'instance_id': 'main_lock',
          'semantic_role': 'entrance_lock',
          'presentation': {
            'display_name': 'Khóa cửa chính',
            'icon': 'lock',
            'section': 'controls',
            'order': 10,
          },
          'properties': [
            {
              'id': 'lock_state',
              'channel': 'reported',
              'path': 'instances.main_lock.reported.lock_state',
              'type': 'string',
              'enum': ['locked', 'unlocked'],
            },
            {
              'id': 'target_lock_state',
              'channel': 'desired',
              'path': 'instances.main_lock.desired.target_lock_state',
              'type': 'string',
              'enum': ['locked', 'unlocked'],
            },
          ],
          'operations': [
            {
              'id': 'lock',
              'permission': 'door.control',
              'risk': 'normal',
              'confirmation': 'none',
              'input': <String, dynamic>{},
              'ack_policy': {'reference': 'lock_state'},
              'effects': [
                {'property': 'target_lock_state', 'value': 'locked'},
              ],
              'presentation': {'label': 'Khóa cửa'},
            },
            {
              'id': 'unlock',
              'permission': 'door.control',
              'risk': 'sensitive',
              'confirmation': 'confirm',
              'input': <String, dynamic>{},
              'ack_policy': {'reference': 'lock_state'},
              'effects': [
                {'property': 'target_lock_state', 'value': 'unlocked'},
              ],
              'presentation': {'label': 'Mở khóa'},
            },
          ],
        },
      ],
    };

Map<String, dynamic> _deviceJson() => {
      'mac': 'aa:bb:cc:dd:ee:ff',
      'owner_id': 'owner-1',
      'name': 'Cửa chính',
      'product_id': 'prod_entrance_controller',
      'catalog_revision': 3,
      'permissions': ['door.control'],
      'role': 'owner',
      'network_id': 'network-1',
      'join_rank': 1,
      'topology_role': 'hub',
      'topology_epoch': 5,
      'topology_state': 'stable',
      'active_hub_mac': 'aa:bb:cc:dd:ee:ff',
      'transport_mode': 'hub',
      'shadow': {
        'is_online': true,
        'state_version': 7,
        'last_seen': '2026-08-04T00:00:00.000Z',
        'instances': {
          'main_lock': {
            'reported': {'lock_state': 'locked'},
          },
        },
        'diagnostics': {
          'system': {'rssi_dbm': -61},
        },
      },
    };

void main() {
  group('V2 catalog and shadow contract', () {
    test('parses published Product metadata without V1 aliases', () {
      final dto = ProductDto.fromJson(_productJson());
      final product = ProductMapper.fromDto(dto);

      expect(product.id, 'prod_entrance_controller');
      expect(product.catalogRevision, 3);
      expect(product.uiProfile, 'entrance_controller');
      expect(product.connectivityProfiles, contains('hub_node'));
      expect(product.firmwareDefaultState, contains('instances'));
      expect(product.capabilityInstances.single.instance, 'main_lock');
    });

    test('parses nested device shadow and canonicalizes MAC', () {
      final dto = DeviceDto.fromJson(_deviceJson());

      expect(dto.mac, 'AA:BB:CC:DD:EE:FF');
      expect(dto.stateVersion, 7);
      expect(
        (dto.instances['main_lock'] as Map)['reported'],
        {'lock_state': 'locked'},
      );
      expect(dto.permissions, ['door.control']);
      expect(dto.topologyRole, 'hub');
    });

    test('assembles only authorized operations and hides desired properties',
        () {
      final product =
          ProductMapper.fromDto(ProductDto.fromJson(_productJson()));
      final device = CapabilityAssembler.assemble(
        DeviceDto.fromJson(_deviceJson()),
        product,
      );

      expect(device.capabilities, hasLength(1));
      final lock = device.capabilities.single;
      expect(lock.id, 'lock_state');
      expect(lock.instance, 'main_lock');
      expect(lock.value, 'locked');
      expect(lock.operations.map((item) => item.operationName),
          ['lock', 'unlock']);
      expect(lock.properties['state_version'], 7);
      expect(device.rawState, {'lock_state': 'locked'});
    });

    test('removes controls when membership lacks the required permission', () {
      final raw = _deviceJson()..['permissions'] = <String>[];
      final product =
          ProductMapper.fromDto(ProductDto.fromJson(_productJson()));
      final device =
          CapabilityAssembler.assemble(DeviceDto.fromJson(raw), product);

      expect(device.capabilities.single.isReadOnly, isTrue);
      expect(device.capabilities.single.operations, isEmpty);
    });
  });

  group('V2 operations', () {
    test('resolves the correct zero-input operation from the target value', () {
      const capability = CapabilityModel(
        id: 'lock_state',
        type: 'enum',
        name: 'Khóa cửa',
        instance: 'main_lock',
        operations: [
          CapabilityOperationDescriptor(operationName: 'lock'),
          CapabilityOperationDescriptor(
            operationName: 'unlock',
            risk: 'sensitive',
            confirmation: 'confirm',
          ),
        ],
      );

      expect(capability.resolveOperation('locked').operationName, 'lock');
      expect(capability.resolveOperation('unlocked').operationName, 'unlock');
    });

    test('sends instance, operation input, state fence and reauth token',
        () async {
      final remote = _RecordingRemoteDataSource();
      final repository = ApiDeviceRepository(remote);
      const capability = CapabilityModel(
        id: 'rain_protection_enabled',
        type: 'on_off',
        name: 'Bảo vệ khi mưa',
        instance: 'roof_automation',
        properties: {'state_version': 12},
        operations: [
          CapabilityOperationDescriptor(
            operationName: 'set_rain_protection',
            inputNames: ['enabled'],
            risk: 'dangerous',
            confirmation: 'reauthenticate',
          ),
        ],
      );

      await repository.updateCapability(
        'AA:BB:CC:DD:EE:FF',
        capability,
        true,
        reauthToken: 'reauth-token',
      );

      expect(remote.lastOperation?['instance_id'], 'roof_automation');
      expect(remote.lastOperation?['operation_name'], 'set_rain_protection');
      expect(remote.lastOperation?['input'], {'enabled': true});
      expect(remote.lastOperation?['expected_state_version'], 12);
      expect(remote.lastReauthToken, 'reauth-token');
    });
  });

  test('maps structured backend errors without a type cast crash', () {
    final error = DioException(
      requestOptions: RequestOptions(path: '/devices'),
      response: Response<Map<String, dynamic>>(
        requestOptions: RequestOptions(path: '/devices'),
        statusCode: 409,
        data: {
          'error': {
            'code': 'STATE_VERSION_CONFLICT',
            'message': 'State changed',
          },
        },
      ),
    );

    expect(
      AppErrorMapper.mapError(error),
      'Trạng thái thiết bị đã thay đổi. Vui lòng thử lại',
    );
  });

  test('maps V2 resource errors and parses credential realtime status', () {
    final error = DioException(
      requestOptions: RequestOptions(path: '/resource-sessions'),
      response: Response<Map<String, dynamic>>(
        requestOptions: RequestOptions(path: '/resource-sessions'),
        statusCode: 403,
        data: {
          'error': {
            'code': 'RESOURCE_FORBIDDEN',
            'message': 'Permission denied',
          },
        },
      ),
    );
    final event = WsEventParser.parse(
      '{"event":"credential_status","mac":"AA:BB:CC:DD:EE:FF",'
      '"payload":{"status":"applied"},"timestamp":"2026-08-04T00:00:00Z"}',
    );

    expect(
      AppErrorMapper.mapError(error),
      'Bạn không có quyền truy cập tài nguyên này',
    );
    expect(event, isA<CredentialStatusEvent>());
    expect((event as CredentialStatusEvent).payload['status'], 'applied');
  });
}
