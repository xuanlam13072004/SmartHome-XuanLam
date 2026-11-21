import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../data/voice_api.dart';
import '../data/voice_models.dart';

final voiceApiProvider = Provider.autoDispose<VoiceApi>((ref) => VoiceApi(ref.watch(dioProvider)));

/// The account's voice profile and lock ("Cá nhân → Giọng nói").
final voiceStateProvider = FutureProvider.autoDispose<VoiceState>((ref) => ref.watch(voiceApiProvider).fetch());
