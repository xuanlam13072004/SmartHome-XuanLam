import 'package:dio/dio.dart';

import 'sharing_models.dart';

/// Device sharing endpoints. Owner calls are refused by the server for members.
class SharingApi {
  SharingApi(this._dio);

  final Dio _dio;

  String _mac(String mac) => Uri.encodeComponent(mac);

  Future<SharingOverview> fetchOverview() async {
    final response = await _dio.get<Map<String, dynamic>>('/me/sharing');
    return SharingOverview.fromJson(response.data!);
  }

  Future<SharedDeviceRef> acceptInvite(String inviteId) async {
    final response = await _dio.post<Map<String, dynamic>>('/me/invites/${Uri.encodeComponent(inviteId)}/accept');
    final device = response.data!['device'] as Map<String, dynamic>;
    return SharedDeviceRef(mac: device['mac'] as String, name: device['name'] as String, productId: '');
  }

  Future<void> declineInvite(String inviteId) async {
    await _dio.post<void>('/me/invites/${Uri.encodeComponent(inviteId)}/decline');
  }

  Future<void> leaveDevice(String mac) async {
    await _dio.delete<void>('/devices/${_mac(mac)}/membership');
  }

  Future<DeviceMembers> fetchMembers(String mac) async {
    final response = await _dio.get<Map<String, dynamic>>('/devices/${_mac(mac)}/members');
    return DeviceMembers.fromJson(response.data!);
  }

  Future<void> invite(String mac, {required String email, required String role}) async {
    await _dio.post<void>('/devices/${_mac(mac)}/invites', data: {'email': email, 'role': role});
  }

  Future<void> cancelInvite(String mac, String inviteId) async {
    await _dio.delete<void>('/devices/${_mac(mac)}/invites/${Uri.encodeComponent(inviteId)}');
  }

  Future<void> changeRole(String mac, String accountId, String role) async {
    await _dio.patch<void>('/devices/${_mac(mac)}/members/${Uri.encodeComponent(accountId)}', data: {'role': role});
  }

  Future<void> removeMember(String mac, String accountId) async {
    await _dio.delete<void>('/devices/${_mac(mac)}/members/${Uri.encodeComponent(accountId)}');
  }
}
