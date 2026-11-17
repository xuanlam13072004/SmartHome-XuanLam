import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/dio_provider.dart';
import '../../../domain/models/ws_events.dart';
import '../../dashboard/providers/realtime_provider.dart';
import '../../notifications/data/notification_models.dart' show CursorPage;
import '../../notifications/providers/notification_providers.dart' show PagedList, PagedNotifier;
import '../data/scene_models.dart';
import '../data/scenes_api.dart';

final scenesApiProvider = Provider.autoDispose<ScenesApi>(
  (ref) => ScenesApi(ref.watch(dioProvider)),
);

/// The account's scenes in display order. Updated in place after this
/// account's own edits; each card's last run follows `scene_run_updated`.
final scenesProvider = AsyncNotifierProvider.autoDispose<ScenesController, SceneList>(ScenesController.new);

class ScenesController extends AutoDisposeAsyncNotifier<SceneList> {
  @override
  Future<SceneList> build() async {
    final subscription = ref.watch(realtimeRepositoryProvider).eventStream.listen((event) {
      if (event is SceneRunEvent) _onRun(SceneRun.fromJson(event.run));
    });
    ref.onDispose(subscription.cancel);
    return ref.watch(scenesApiProvider).fetchScenes();
  }

  ScenesApi get _api => ref.read(scenesApiProvider);

  void _change(List<Scene> Function(List<Scene> scenes) update) {
    final current = state.valueOrNull;
    if (current != null) state = AsyncData(current.withScenes(update(current.scenes)));
  }

  void _onRun(SceneRun run) {
    final scene = state.valueOrNull?.byId(run.sceneId);
    // A schedule just fired: reload once for its next time and last result.
    if (run.trigger == 'schedule' && scene != null && scene.lastRunId != run.id) {
      ref.invalidateSelf();
      return;
    }
    _change((scenes) => [for (final scene in scenes) scene.id == run.sceneId ? scene.withRun(run) : scene]);
  }

  void _changeSchedules(String sceneId, List<SceneSchedule> Function(List<SceneSchedule> schedules) update) {
    _change((scenes) => [
          for (final scene in scenes) scene.id == sceneId ? scene.withSchedules(update(scene.schedules)) : scene,
        ]);
  }

  Future<SceneSchedule> addSchedule(String sceneId, {required String time, required List<int> days}) async {
    final schedule = await _api.createSchedule(sceneId, time: time, days: days, timezone: AppConfig.timeZone);
    _changeSchedules(sceneId, (schedules) => [...schedules, schedule]..sort((a, b) => a.time.compareTo(b.time)));
    return schedule;
  }

  Future<SceneSchedule> editSchedule(SceneSchedule schedule, {String? time, List<int>? days, bool? enabled}) async {
    final updated = await _api.updateSchedule(
      schedule.id,
      time: time,
      days: days,
      enabled: enabled,
      // Saved again in the app's zone whenever the time itself changes.
      timezone: time != null || days != null ? AppConfig.timeZone : null,
    );
    _changeSchedules(schedule.sceneId, (schedules) => [
          for (final item in schedules) item.id == schedule.id ? updated : item,
        ]..sort((a, b) => a.time.compareTo(b.time)));
    return updated;
  }

  Future<void> removeSchedule(SceneSchedule schedule) async {
    await _api.deleteSchedule(schedule.id);
    _changeSchedules(schedule.sceneId, (schedules) => schedules.where((item) => item.id != schedule.id).toList());
  }

  Future<Scene> create({required String name, required String icon, required List<SceneStep> steps}) async {
    final scene = await _api.createScene(name: name, icon: icon, steps: steps);
    _change((scenes) => [...scenes, scene]);
    return scene;
  }

  Future<Scene> edit(String id, {String? name, String? icon, List<SceneStep>? steps}) async {
    final scene = await _api.updateScene(id, name: name, icon: icon, steps: steps);
    _change((scenes) => [for (final item in scenes) item.id == id ? scene : item]);
    return scene;
  }

  Future<void> delete(String id) async {
    await _api.deleteScene(id);
    _change((scenes) => scenes.where((scene) => scene.id != id).toList());
  }

  Future<void> reorder(List<String> sceneIds) async {
    final before = state.valueOrNull;
    if (before == null) return;
    final byId = {for (final scene in before.scenes) scene.id: scene};
    state = AsyncData(before.withScenes([
      for (var index = 0; index < sceneIds.length; index++)
        if (byId[sceneIds[index]] != null) byId[sceneIds[index]]!.withPosition(index),
    ]));
    try {
      await _api.reorder(sceneIds);
    } catch (_) {
      state = AsyncData(before);
      rethrow;
    }
  }

  Future<SceneRun> run(Scene scene, {String? reauthToken}) async {
    final run = await _api.run(scene.id, reauthToken: reauthToken);
    _onRun(run);
    return run;
  }
}

/// Devices and the operations a step may use (the server decides).
final sceneActionsProvider = FutureProvider.autoDispose<List<SceneActionDevice>>(
  (ref) => ref.watch(scenesApiProvider).fetchActions(),
);

/// One run, kept live by `scene_run_updated`. While it runs it is also
/// reloaded every few seconds, in case the realtime connection drops.
final sceneRunProvider =
    AsyncNotifierProvider.autoDispose.family<SceneRunController, SceneRun, String>(SceneRunController.new);

class SceneRunController extends AutoDisposeFamilyAsyncNotifier<SceneRun, String> {
  Timer? _poll;

  @override
  Future<SceneRun> build(String runId) async {
    SceneRun? pushed;
    final subscription = ref.watch(realtimeRepositoryProvider).eventStream.listen((event) {
      if (event is SceneRunEvent && event.run['id'] == runId) {
        pushed = SceneRun.fromJson(event.run);
        if (state.hasValue) _set(pushed!);
      }
    });
    ref.onDispose(() {
      subscription.cancel();
      _poll?.cancel();
    });
    final fetched = await ref.watch(scenesApiProvider).fetchRun(runId);
    final run = pushed != null && _progress(pushed!) > _progress(fetched) ? pushed! : fetched;
    _schedulePoll(run);
    return run;
  }

  /// Higher means further along: finished > more steps settled.
  static int _progress(SceneRun run) =>
      (run.running ? 0 : 1000) + run.steps.where((step) => step.status == 'succeeded' || step.status == 'failed').length;

  void _set(SceneRun run) {
    final current = state.valueOrNull;
    if (current != null && _progress(run) < _progress(current)) return;
    state = AsyncData(run);
    _schedulePoll(run);
  }

  void _schedulePoll(SceneRun run) {
    _poll?.cancel();
    if (!run.running) return;
    _poll = Timer(const Duration(seconds: 5), () async {
      try {
        _set(await ref.read(scenesApiProvider).fetchRun(arg));
      } catch (_) {
        _schedulePoll(run);
      }
    });
  }
}

/// "Lịch sử chạy": every run of the account, newest first.
class SceneRunsNotifier extends PagedNotifier<SceneRun> {
  @override
  Future<CursorPage<SceneRun>> fetch(String? before) => ref.read(scenesApiProvider).fetchRuns(before: before);
}

final sceneRunsProvider =
    AsyncNotifierProvider.autoDispose<SceneRunsNotifier, PagedList<SceneRun>>(SceneRunsNotifier.new);
