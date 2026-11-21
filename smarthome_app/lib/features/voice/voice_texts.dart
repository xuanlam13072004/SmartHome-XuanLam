/// Sentences to read and labels of the voice feature.
library;

import 'dart:math' as math;

abstract final class VoiceTexts {
  /// Varied sounds of Vietnamese, each 3–4 seconds read at a normal pace.
  static const enrollSentences = [
    'Hôm nay trời đẹp, tôi muốn mở cửa sổ phòng khách.',
    'Trợ lý ơi, bật đèn phòng ngủ và tắt quạt giúp tôi.',
    'Một, hai, ba, bốn, năm, sáu, bảy, tám, chín, mười.',
  ];

  static const calibrationSentences = [
    'Nhà thông minh giúp cuộc sống tiện lợi và an toàn hơn.',
    'Hãy khóa cửa chính lúc mười giờ tối mỗi ngày.',
    'Tôi đang kiểm tra giọng nói của mình trên điện thoại.',
  ];

  static const otherSentences = [
    'Buổi sáng tôi thường uống cà phê và đọc tin tức.',
    'Giọng nói của tôi là chìa khóa để điều khiển ngôi nhà.',
    'Chiều nay nhớ tưới cây ngoài ban công nhé.',
    'Tắt hết đèn trong nhà khi tôi ra ngoài.',
  ];

  static String randomSentence([math.Random? random]) {
    const all = [...enrollSentences, ...calibrationSentences, ...otherSentences];
    return all[(random ?? math.Random()).nextInt(all.length)];
  }

  static String reason(String? reason) => switch (reason) {
        'not_matched' => 'Giọng nói không khớp với giọng đã đăng ký',
        'spoof_suspected' => 'Nghi ngờ giọng phát lại từ loa hoặc giọng máy',
        'low_confidence' => 'Chưa đủ chắc chắn, hãy nói lại rõ hơn',
        _ => 'Không xác minh được',
      };
}
