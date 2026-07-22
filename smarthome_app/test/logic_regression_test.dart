import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/utils/app_error_mapper.dart';
import 'package:smarthome_app/data/datasources/remote/device_remote_data_source.dart';
import 'package:smarthome_app/data/models/dto/device_dto.dart';
import 'package:smarthome_app/data/models/dto/product_dto.dart';
import 'package:smarthome_app/domain/mappers/capability_assembler.dart';
import 'package:smarthome_app/domain/models/product_model.dart';
import 'package:smarthome_app/features/dashboard/models/device_qr_payload.dart';
import 'package:smarthome_app/features/dashboard/repositories/device_repository.dart';

class _RecordingDeviceRemoteDataSource implements IDeviceRemoteDataSource {
  String? action;
  String? instance;
  Map<String, dynamic>? payload;

  @override
  Future<void> sendCommand(
    String mac,
    String action,
    String instance,
    Map<String, dynamic> payload,
  ) async {
    this.action = action;
    this.instance = instance;
    this.payload = payload;
  }

  @override
  Future<DeviceDto> claimDevice(
    String mac,
    String secretKey, {
    String? name,
  }) async =>
      throw UnsupportedError('Not used by this test');

  @override
  Future<List<DeviceDto>> getDevices() async => const [];

  @override
  Future<List<ProductDto>> getProducts() async => const [];

  @override
  Future<void> unpairDevice(String mac) async {}

  @override
  Future<DeviceDto> updateDeviceName(String mac, String name) async =>
      throw UnsupportedError('Not used by this test');
}

ProductModel _productWith(CapabilityInstance instance) => ProductModel(
      id: 'product-1',
      manufacturer: 'Test',
      modelName: 'Test',
      displayName: 'Test',
      firmwareFamily: 'test',
      connectivity: 'wifi',
      category: 'test',
      icon: 'device',
      description: '',
      defaultState: const {},
      capabilityInstances: [instance],
    );

DeviceDto _device(Map<String, dynamic> state) => DeviceDto(
      mac: 'AA:BB:CC:DD:EE:FF',
      ownerId: 'owner-1',
      name: 'Test device',
      productId: 'product-1',
      isActive: true,
      isOnline: true,
      state: state,
      diagnostics: const {},
    );

void main() {
  group('AppErrorMapper', () {
    test('maps the nested backend error contract without a type cast crash',
        () {
      final request = RequestOptions(path: '/devices/claim');
      final error = DioException(
        requestOptions: request,
        type: DioExceptionType.badResponse,
        response: Response<Map<String, dynamic>>(
          requestOptions: request,
          statusCode: 409,
          data: const {
            'error': {
              'code': 'DEVICE_ALREADY_CLAIMED',
              'message': 'Already claimed',
            },
          },
        ),
      );

      expect(
        AppErrorMapper.mapError(error),
        'Thiết bị đã được liên kết với tài khoản khác',
      );
    });
  });

  group('DeviceQrPayload', () {
    test('reads canonical secret_key and normalizes MAC', () {
      final payload = DeviceQrPayload.parse(
        '{"type":"smarthome-device","version":1,'
        '"mac":"aa:bb:cc:dd:ee:ff","secret_key":" device-secret "}',
      );

      expect(payload.mac, 'AA:BB:CC:DD:EE:FF');
      expect(payload.secretKey, 'device-secret');
    });

    test('keeps legacy secret compatible and rejects invalid MAC', () {
      expect(
        DeviceQrPayload.parse(
          '{"mac":"AA:BB:CC:DD:EE:FF","secret":"legacy-secret"}',
        ).secretKey,
        'legacy-secret',
      );
      expect(
        () => DeviceQrPayload.parse(
          '{"mac":"not-a-mac","secret_key":"device-secret"}',
        ),
        throwsFormatException,
      );
    });
  });

  group('Capability command mapping', () {
    test('uses the command action and argument belonging to each state',
        () async {
      final product = _productWith(CapabilityInstance(
        capabilityId: 'light_controller',
        instance: 'main_light',
        valueType: '',
        validation: const {},
        stateProperties: const {
          'power': {
            'value_type': 'boolean',
            'validation': {'required': true},
          },
          'brightness': {
            'value_type': 'number',
            'validation': {'min': 0, 'max': 100},
          },
        },
        diagnosticProperties: const {},
        commands: [
          CapabilityCommand(
            action: 'SET_LIGHT_POWER',
            arguments: const [
              {'name': 'value'},
            ],
          ),
          CapabilityCommand(
            action: 'SET_BRIGHTNESS',
            arguments: const [
              {'name': 'brightness'},
            ],
          ),
        ],
      ));
      final device = CapabilityAssembler.assemble(
        _device(const {'power': false, 'brightness': 30}),
        product,
      );
      final remote = _RecordingDeviceRemoteDataSource();
      final repository = ApiDeviceRepository(remote);

      final brightness =
          device.capabilities.singleWhere((item) => item.id == 'brightness');
      await repository.updateCapability(device.mac, brightness, 75);

      expect(remote.action, 'SET_BRIGHTNESS');
      expect(remote.instance, 'main_light');
      expect(remote.payload, const {'brightness': 75});
    });

    test('keeps reported cover position read-only and maps desired state',
        () async {
      final product = _productWith(CapabilityInstance(
        capabilityId: 'cover_controller',
        instance: 'roof_motor',
        valueType: '',
        validation: const {},
        stateProperties: const {
          'target_position': {
            'value_type': 'number',
            'validation': {'min': 0, 'max': 100},
          },
          'current_position': {
            'value_type': 'number',
            'validation': {'min': 0, 'max': 100},
          },
          'movement_status': {
            'value_type': 'string',
            'validation': {
              'enum': ['opening', 'closing', 'stopped'],
            },
          },
        },
        diagnosticProperties: const {},
        commands: [
          CapabilityCommand(action: 'OPEN', arguments: const []),
          CapabilityCommand(action: 'CLOSE', arguments: const []),
          CapabilityCommand(action: 'STOP', arguments: const []),
          CapabilityCommand(
            action: 'SET_POSITION',
            arguments: const [
              {'name': 'position'},
            ],
          ),
        ],
      ));
      final device = CapabilityAssembler.assemble(
        _device(const {
          'target_position': 0,
          'current_position': 20,
          'movement_status': 'stopped',
        }),
        product,
      );
      final current = device.capabilities
          .singleWhere((item) => item.id == 'current_position');
      final target = device.capabilities
          .singleWhere((item) => item.id == 'target_position');
      final movement = device.capabilities
          .singleWhere((item) => item.id == 'movement_status');

      expect(current.isReadOnly, isTrue);
      expect(current.commands, isEmpty);
      expect(target.commands.single.action, 'SET_POSITION');
      expect(target.commands.single.argumentNames, const ['position']);

      final remote = _RecordingDeviceRemoteDataSource();
      final repository = ApiDeviceRepository(remote);
      await repository.updateCapability(device.mac, movement, 'closing');
      expect(remote.action, 'CLOSE');
      expect(remote.payload, isEmpty);
    });
  });
}
