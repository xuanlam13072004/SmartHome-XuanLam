import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../auth/providers/auth_provider.dart';
import '../../automations/providers/automations_providers.dart';
import '../../payments/data/payment_models.dart';
import '../../payments/data/payments_api.dart';
import '../../payments/providers/payments_providers.dart';
import '../../scenes/providers/scenes_providers.dart';
import '../data/assistant_api.dart';
import '../data/assistant_models.dart';
import '../data/chat_texts.dart';
import 'assistant_providers.dart';

enum ChatRole { user, assistant, error }

/// A plan offer in the chat: waiting for a tap, creating the order, done, or turned down.
enum OfferState { open, ordering, ordered, dismissed }

/// A drafted scene/automation: waiting for "Lưu", saving, saved, or turned down.
enum DraftState { open, saving, saved, dismissed }

/// One message of the conversation.
class ChatEntry {
  ChatEntry.user(this.text, {this.spoken = false, this.working = false})
      : role = ChatRole.user,
        actions = [],
        options = const [],
        quota = false,
        offer = null,
        draft = null,
        orderCode = null;

  ChatEntry.assistant(
    this.text, {
    List<AssistantAction> actions = const [],
    this.options = const [],
    this.offer,
    this.draft,
    this.orderCode,
    this.working = false,
  })  : role = ChatRole.assistant,
        actions = [...actions],
        spoken = false,
        quota = false;

  ChatEntry.error(this.text, {this.quota = false})
      : role = ChatRole.error,
        actions = [],
        options = const [],
        spoken = false,
        working = false,
        offer = null,
        draft = null,
        orderCode = null;

  final ChatRole role;
  String text;

  /// Commands of the turn; replaced in place as they are confirmed.
  final List<AssistantAction> actions;

  /// Choices offered with a question back.
  final List<String> options;

  /// The user's message was spoken.
  final bool spoken;

  /// Waiting for the server.
  bool working;

  /// The month's allowance is used up: offer the plans.
  final bool quota;

  /// A plan to buy, and what happened to the offer.
  final PlanOffer? offer;
  OfferState offerState = OfferState.open;

  /// A scene/automation to save, and what happened to it.
  final AssistantDraft? draft;
  DraftState draftState = DraftState.open;

  /// What saving the draft created (to open it).
  String? savedSceneId;
  String? savedAutomationId;

  /// The order this message shows (QR, then its result).
  final String? orderCode;
}

/// The assistant conversation, kept while the user moves around the app and
/// cleared when they sign out. Orders made in the chat are followed here
/// (polling while the chat is open, realtime events always) and every change
/// is announced in the conversation.
class AssistantChat extends ChangeNotifier {
  AssistantChat(this._ref);

  final Ref _ref;
  final List<ChatEntry> entries = [];
  final Map<String, PaymentOrder> _orders = {};

  /// Orders replaced by a newer one (the server cancels them): no longer followed.
  final Set<String> _replaced = {};
  final StreamController<String> _speech = StreamController<String>.broadcast();
  Timer? _poll;
  bool _busy = false;
  bool _disposed = false;

  bool get busy => _busy;

  /// Lines the open chat may read aloud.
  Stream<String> get speech => _speech.stream;

  /// The chat screen is showing.
  bool get onScreen => _speech.hasListener;

  PaymentOrder? order(String code) => _orders[code];

  bool isReplaced(String code) => _replaced.contains(code);

  AssistantApi get _api => _ref.read(assistantApiProvider);
  PaymentsApi get _payments => _ref.read(paymentsApiProvider);

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void _say(ChatEntry entry) {
    entries.add(entry);
    if (entry.text.isNotEmpty && !_speech.isClosed) _speech.add(entry.text);
  }

  void _error(Object error) {
    entries.add(ChatEntry.error(
      AppErrorMapper.mapError(error),
      quota: AppErrorMapper.codeOf(error) == 'ASSISTANT_QUOTA_EXCEEDED',
    ));
  }

  void _showReply(AssistantReply reply) {
    _say(ChatEntry.assistant(
      reply.reply,
      actions: reply.actions,
      options: reply.options,
      offer: reply.offer,
      draft: reply.draft,
    ));
    _ref.invalidate(assistantUsageProvider);
  }

  Future<void> sendText(String text) async {
    final message = text.trim();
    if (message.isEmpty || _busy) return;
    final pending = ChatEntry.assistant('', working: true);
    _busy = true;
    entries
      ..add(ChatEntry.user(message))
      ..add(pending);
    _changed();
    try {
      final reply = await _api.send(message);
      entries.remove(pending);
      _showReply(reply);
    } catch (error) {
      entries.remove(pending);
      _error(error);
    } finally {
      _busy = false;
      _changed();
    }
  }

  Future<void> sendVoice(Uint8List wav) async {
    if (_busy) return;
    final heard = ChatEntry.user('Đang nghe…', spoken: true, working: true);
    final pending = ChatEntry.assistant('', working: true);
    _busy = true;
    entries
      ..add(heard)
      ..add(pending);
    _changed();
    try {
      final reply = await _api.sendVoice(wav);
      heard
        ..text = reply.transcript ?? reply.message
        ..working = false;
      entries.remove(pending);
      _showReply(reply);
    } catch (error) {
      entries
        ..remove(heard)
        ..remove(pending);
      _error(error);
    } finally {
      _busy = false;
      _changed();
    }
  }

  /// Runs a command that waited for the user ([reauthToken] after the password).
  Future<void> confirmAction(ChatEntry entry, AssistantAction action, {String? reauthToken}) async {
    try {
      final result = await _api.confirm(action.pendingId!, reauthToken: reauthToken);
      final index = entry.actions.indexOf(action);
      if (index >= 0) entry.actions[index] = result.action;
      _say(ChatEntry.assistant(result.reply));
    } catch (error) {
      if (AppErrorMapper.codeOf(error) == 'ASSISTANT_PENDING_NOT_FOUND') {
        final index = entry.actions.indexOf(action);
        if (index >= 0) entry.actions[index] = action.copyWith(status: 'failed', reason: 'hết hạn');
      }
      _error(error);
    }
    _changed();
  }

  /// The user saved a draft: the scene/automation is created now.
  Future<void> saveDraft(ChatEntry entry) async {
    final draft = entry.draft;
    if (draft == null || entry.draftState != DraftState.open) return;
    entry.draftState = DraftState.saving;
    _changed();
    try {
      final saved = await _api.saveDraft(draft.id, timezone: AppConfig.timeZone);
      entry
        ..draftState = DraftState.saved
        ..savedSceneId = saved.sceneId
        ..savedAutomationId = saved.automationId;
      _ref
        ..invalidate(scenesProvider)
        ..invalidate(automationsProvider);
      _say(ChatEntry.assistant(saved.reply));
    } catch (error) {
      entry.draftState = AppErrorMapper.codeOf(error) == 'ASSISTANT_DRAFT_NOT_FOUND' ? DraftState.dismissed : DraftState.open;
      _error(error);
    }
    _changed();
  }

  void dismissDraft(ChatEntry entry) {
    if (entry.draftState != DraftState.open) return;
    entry.draftState = DraftState.dismissed;
    _changed();
  }

  /// A plan picked from the list shown when the allowance ran out.
  void offerPlan(PaymentPlan plan) {
    final offer = PlanOffer.fromPlan(plan);
    _say(ChatEntry.assistant(ChatTexts.offerFromList(offer), offer: offer));
    _changed();
  }

  void dismissOffer(ChatEntry entry) {
    if (entry.offerState != OfferState.open) return;
    entry.offerState = OfferState.dismissed;
    _say(ChatEntry.assistant(ChatTexts.offerDismissed));
    _changed();
  }

  /// The user confirmed the offer: create the order and show its QR.
  Future<void> buy(ChatEntry entry, int months) async {
    final offer = entry.offer;
    if (offer == null || entry.offerState != OfferState.open) return;
    entry.offerState = OfferState.ordering;
    _changed();
    if (await _order(offer.planCode, months)) {
      entry.offerState = OfferState.ordered;
    } else {
      entry.offerState = OfferState.open;
    }
    _changed();
  }

  /// A new QR for an order whose code expired (same plan and months).
  Future<void> renew(String code) async {
    final old = _orders[code];
    if (old == null || _busy) return;
    _busy = true;
    _changed();
    await _order(old.planCode, old.months);
    _busy = false;
    _changed();
  }

  Future<bool> _order(String planCode, int months) async {
    try {
      final order = await _payments.createOrder(planCode: planCode, months: months);
      // The server keeps one unpaid order per account: older ones are cancelled quietly.
      for (final previous in _orders.values) {
        if (previous.open || previous.status == 'expired') _replaced.add(previous.code);
      }
      _orders[order.code] = order;
      _say(ChatEntry.assistant(ChatTexts.orderCreated(order), orderCode: order.code));
      _ref.invalidate(paymentOrdersProvider);
      _follow();
      return true;
    } catch (error) {
      _error(error);
      return false;
    }
  }

  Future<void> simulate(String code) => _act(() async => onOrderUpdate(await _payments.simulate(code)));

  Future<void> cancelOrder(String code) => _act(() async {
        await _payments.cancel(code);
        onOrderUpdate(await _payments.order(code));
        _ref.invalidate(paymentOrdersProvider);
      });

  Future<void> _act(Future<void> Function() action) async {
    if (_busy) return;
    _busy = true;
    _changed();
    try {
      await action();
    } catch (error) {
      _error(error);
    } finally {
      _busy = false;
      _changed();
    }
  }

  /// A newer state of an order (polling, a button, or a realtime event).
  /// Returns whether the chat follows that order.
  bool onOrderUpdate(PaymentOrder order) {
    final before = _orders[order.code];
    if (before == null) return false;
    _orders[order.code] = order;
    final justPaid = order.paid && !before.paid;
    // A replaced order is only mentioned again if money still arrives for it.
    if (!_replaced.contains(order.code) || justPaid) {
      final line = ChatTexts.orderChanged(before, order);
      if (line != null) _say(ChatEntry.assistant(line));
    }
    if (justPaid) {
      _ref
        ..invalidate(assistantUsageProvider)
        ..invalidate(paymentOrdersProvider);
    }
    _follow();
    _changed();
    return true;
  }

  Iterable<PaymentOrder> get _open => _orders.values.where((order) => order.open && !_replaced.contains(order.code));

  /// Polls the open orders every few seconds while the chat is on screen.
  void _follow() {
    final needed = onScreen && _open.isNotEmpty;
    if (!needed) {
      _poll?.cancel();
      _poll = null;
    } else {
      _poll ??= Timer.periodic(const Duration(seconds: 4), (_) => unawaited(_refresh()));
    }
  }

  Future<void> _refresh() async {
    for (final order in _open.toList()) {
      try {
        onOrderUpdate(await _payments.order(order.code));
      } catch (_) {
        // A missed poll is retried; the realtime event also brings the result.
      }
    }
  }

  /// The chat screen opened: catch up on the orders and follow them.
  void resume() {
    unawaited(_refresh());
    _follow();
  }

  /// The chat screen closed (realtime events still update the orders).
  void pause() {
    _poll?.cancel();
    _poll = null;
  }

  /// Starts a new conversation (open orders are still followed).
  Future<void> reset() async {
    entries.clear();
    _changed();
    try {
      await _api.reset();
    } catch (_) {
      // The server forgets the conversation after 15 minutes anyway.
    }
  }

  /// Signed out: forget everything.
  void clear() {
    pause();
    entries.clear();
    _orders.clear();
    _replaced.clear();
    _busy = false;
    _changed();
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    unawaited(_speech.close());
    super.dispose();
  }
}

/// The conversation lives as long as the session.
final assistantChatProvider = ChangeNotifierProvider<AssistantChat>((ref) {
  final chat = AssistantChat(ref);
  ref.listen<AuthState>(authControllerProvider, (previous, next) {
    if (next == AuthState.unauthenticated || next == AuthState.expired) chat.clear();
  });
  return chat;
});
