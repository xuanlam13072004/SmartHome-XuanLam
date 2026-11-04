import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/datasources/remote/device_event_remote_data_source.dart';
import '../../../domain/models/device_event_model.dart';
import '../../../domain/models/ws_events.dart';
import 'realtime_provider.dart';

final deviceEventsProvider = StreamProvider.autoDispose
    .family<List<DeviceEventModel>, String>((ref, macInput) async* {
  final mac = macInput.trim().toUpperCase();
  final remote = ref.watch(deviceEventRemoteDataSourceProvider);
  final realtime = ref.watch(realtimeRepositoryProvider);
  final pendingRealtime = StreamController<DeviceEventEvent>();
  final realtimeSubscription = realtime.eventStream
      .where((event) => event is DeviceEventEvent && event.mac == mac)
      .cast<DeviceEventEvent>()
      .listen(pendingRealtime.add, onError: pendingRealtime.addError);
  ref.onDispose(() {
    realtimeSubscription.cancel();
    pendingRealtime.close();
  });

  var current = await remote.getEvents(mac);
  yield current;

  // Subscribe before the REST request so an event emitted while the initial
  // history is loading is buffered rather than falling into a race window.
  await for (final event in pendingRealtime.stream) {
    final incoming = DeviceEventModel.fromJson({
      ...event.payload,
      'device_id': mac,
      'received_at': event.payload['received_at'] ?? event.timestamp,
    });
    if (incoming.eventId.isEmpty) continue;
    current = [
      incoming,
      ...current.where((item) => item.eventId != incoming.eventId),
    ].take(50).toList(growable: false);
    yield current;
  }
});
