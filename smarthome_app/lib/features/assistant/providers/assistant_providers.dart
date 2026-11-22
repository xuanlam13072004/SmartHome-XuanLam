import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../data/assistant_api.dart';
import '../data/assistant_models.dart';

final assistantApiProvider = Provider.autoDispose<AssistantApi>((ref) => AssistantApi(ref.watch(dioProvider)));

/// The current plan and this month's assistant usage.
final assistantUsageProvider =
    FutureProvider.autoDispose<AssistantUsage>((ref) => ref.watch(assistantApiProvider).usage());
