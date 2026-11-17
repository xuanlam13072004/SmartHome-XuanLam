import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/dio_provider.dart';
import '../../../domain/models/ws_events.dart';
import '../../dashboard/providers/realtime_provider.dart';
import '../../scenes/providers/scenes_providers.dart';
import '../data/automation_models.dart';
import '../data/automations_api.dart';

final automationsApiProvider = Provider.autoDispose<AutomationsApi>(
  (ref) => AutomationsApi(ref.watch(dioProvider)),
);

/// The account's automations, oldest first. Updated in place after this
/// account's own edits; each card's last result follows `automation_fired`.
final automationsProvider =
    AsyncNotifierProvider.autoDispose<AutomationsController, AutomationList>(AutomationsController.new);

class AutomationsController extends AutoDisposeAsyncNotifier<AutomationList> {
  @override
  Future<AutomationList> build() async {
    final subscription = ref.watch(realtimeRepositoryProvider).eventStream.listen((event) {
      if (event is AutomationFiredEvent) _onFired(event.status);
    });
    ref.onDispose(subscription.cancel);
    return ref.watch(automationsApiProvider).fetchAutomations();
  }

  AutomationsApi get _api => ref.read(automationsApiProvider);

  void _change(List<Automation> Function(List<Automation> automations) update) {
    final current = state.valueOrNull;
    if (current != null) state = AsyncData(current.withAutomations(update(current.automations)));
  }

  void _replace(Automation automation) => _change((automations) => [
        for (final item in automations) item.id == automation.id ? automation : item,
      ]);

  void _onFired(Map<String, dynamic> status) {
    final automation = state.valueOrNull?.byId(status['automation_id'] as String?);
    if (automation != null) _replace(automation.withStatus(status));
  }

  Future<Automation> create(AutomationDraft draft) async {
    final automation = await _api.create(draft);
    _change((automations) => [...automations, automation]);
    ref.invalidate(automationSuggestionsProvider);
    return automation;
  }

  Future<Automation> replace(String id, AutomationDraft draft) async {
    final automation = await _api.replace(id, draft);
    _replace(automation);
    return automation;
  }

  Future<void> setEnabled(Automation automation, bool enabled) async {
    _replace(await _api.setEnabled(automation.id, enabled));
  }

  Future<void> delete(String id) async {
    await _api.delete(id);
    _change((automations) => automations.where((item) => item.id != id).toList());
    // A suggestion comes back once the automation made from it is gone.
    ref.invalidate(automationSuggestionsProvider);
  }

  /// Adds [suggestion] (and the scene it runs, if any) as an enabled automation.
  Future<Automation> applySuggestion(AutomationSuggestion suggestion) async {
    final automation = await _api.applySuggestion(suggestion.key, timezone: AppConfig.timeZone);
    _change((automations) => [...automations, automation]);
    ref.invalidate(automationSuggestionsProvider);
    if (automation.sceneId != null) ref.invalidate(scenesProvider);
    return automation;
  }
}

/// Devices with the states and events an automation may use (the server decides).
final automationOptionsProvider = FutureProvider.autoDispose<List<AutomationDevice>>(
  (ref) => ref.watch(automationsApiProvider).fetchOptions(),
);

/// "Gợi ý" for the account's devices, not added yet.
final automationSuggestionsProvider = FutureProvider.autoDispose<List<AutomationSuggestion>>(
  (ref) => ref.watch(automationsApiProvider).fetchSuggestions(),
);
