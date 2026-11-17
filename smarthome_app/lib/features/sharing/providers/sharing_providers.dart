import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../data/sharing_api.dart';
import '../data/sharing_models.dart';

final sharingApiProvider = Provider.autoDispose<SharingApi>(
  (ref) => SharingApi(ref.watch(dioProvider)),
);

/// "Chia sẻ thiết bị": invitations, devices shared with me, my devices.
final sharingOverviewProvider = FutureProvider.autoDispose<SharingOverview>(
  (ref) => ref.watch(sharingApiProvider).fetchOverview(),
);

/// Members and open invitations of one of my devices.
final deviceMembersProvider = FutureProvider.autoDispose.family<DeviceMembers, String>(
  (ref, mac) => ref.watch(sharingApiProvider).fetchMembers(mac),
);

/// Display name of a product ("Camera an ninh"), from the cached catalog.
final productNameProvider = FutureProvider.autoDispose.family<String, String>((ref, productId) async {
  final product = await ref.watch(deviceRepositoryProvider).getProduct(productId);
  return product?.displayName ?? '';
});
