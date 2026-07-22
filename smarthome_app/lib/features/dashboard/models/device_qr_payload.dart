import 'dart:convert';

class DeviceQrPayload {
  const DeviceQrPayload({
    required this.mac,
    required this.secretKey,
  });

  final String mac;
  final String secretKey;

  factory DeviceQrPayload.parse(String rawData) {
    final decoded = jsonDecode(rawData);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('QR payload must be a JSON object');
    }

    final type = decoded['type'];
    final version = decoded['version'];
    if (type != null && type != 'smarthome-device') {
      throw const FormatException('Unsupported QR type');
    }
    if (version != null && version != 1) {
      throw const FormatException('Unsupported QR version');
    }

    final mac = decoded['mac']?.toString().trim().toUpperCase() ?? '';
    // secret_key is canonical; secret remains accepted for already printed QR.
    final secretKey =
        (decoded['secret_key'] ?? decoded['secret'])?.toString().trim() ?? '';
    final macRegex = RegExp(r'^([0-9A-F]{2}:){5}[0-9A-F]{2}$');

    if (!macRegex.hasMatch(mac) || secretKey.isEmpty) {
      throw const FormatException('Invalid device credentials');
    }

    return DeviceQrPayload(mac: mac, secretKey: secretKey);
  }
}
