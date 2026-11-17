import 'package:flutter/widgets.dart';
import 'package:lucide_icons/lucide_icons.dart';

class HelpTopic {
  const HelpTopic({
    required this.icon,
    required this.title,
    required this.steps,
    this.numbered = true,
  });

  final IconData icon;
  final String title;
  final List<String> steps;
  final bool numbered;
}

const helpGuides = <HelpTopic>[
  HelpTopic(
    icon: LucideIcons.plusCircle,
    title: 'Thêm thiết bị mới',
    steps: [
      'Ở trang Tổng quan, nhấn nút + để mở màn hình thêm thiết bị.',
      'Đưa camera vào tem QR dán trên thiết bị. Nếu không quét được, chọn "Dán mã ghép nối" hoặc "Nhập mã thủ công".',
      'Đặt tên dễ nhớ cho thiết bị rồi xác nhận. Thiết bị xuất hiện trong danh sách sau vài giây khi đã có điện và Wi-Fi.',
    ],
  ),
  HelpTopic(
    icon: LucideIcons.video,
    title: 'Xem camera trực tiếp và xem lại',
    steps: [
      'Mở thiết bị camera, chọn "Trực tiếp" để xem hình ngay lúc này.',
      'Chọn "Xem lại" để mở thước thời gian: đoạn tô vàng là có bản ghi, đoạn trắng là không có.',
      'Chụm hai ngón hoặc cuộn chuột để phóng to thước (nhỏ nhất 2 phút), kéo để di chuyển, chạm vào đoạn vàng để phát.',
    ],
  ),
  HelpTopic(
    icon: LucideIcons.users,
    title: 'Chia sẻ thiết bị cho người thân',
    steps: [
      'Mở thiết bị → menu ⋮ → Chia sẻ thiết bị (hoặc Cá nhân → Chia sẻ thiết bị → chọn thiết bị).',
      'Nhấn "Mời người dùng", nhập email và chọn quyền: Chỉ xem hoặc Điều khiển.',
      'Người được mời đăng nhập bằng email đó, vào Cá nhân → Chia sẻ thiết bị để chấp nhận. Lời mời hết hạn sau 7 ngày.',
      'Chạm vào một người trong danh sách để đổi quyền hoặc xóa quyền truy cập bất cứ lúc nào.',
    ],
  ),
  HelpTopic(
    icon: LucideIcons.shieldCheck,
    title: 'Giữ tài khoản an toàn',
    steps: [
      'Cá nhân → Phiên đăng nhập: xem các máy đang đăng nhập, đăng xuất máy lạ.',
      'Cá nhân → Đổi mật khẩu: các máy khác sẽ bị đăng xuất ngay, máy đang dùng vẫn giữ đăng nhập.',
      'Quyền xóa bản ghi camera, mã PIN, cài đặt an toàn và gỡ thiết bị không bao giờ được chia sẻ.',
    ],
  ),
  HelpTopic(
    icon: LucideIcons.bell,
    title: 'Thông báo và lịch sử',
    steps: [
      'Cảnh báo từ thiết bị (khói, khí gas, sai mã PIN, trời mưa…) hiện ngay khi đang mở ứng dụng và được lưu ở Cá nhân → Thông báo.',
      'Cá nhân → Loại thông báo: tắt những loại không cần. Cảnh báo cháy nổ luôn bật.',
      'Cá nhân → Lịch sử hoạt động: xem lại các thao tác bạn đã làm.',
    ],
  ),
  HelpTopic(
    icon: LucideIcons.sunMoon,
    title: 'Đổi giao diện sáng / tối',
    steps: [
      'Vào Cá nhân → Cài đặt ứng dụng → Giao diện.',
      'Chọn Sáng, Tối hoặc Theo hệ thống. Lựa chọn được lưu trên máy này.',
    ],
  ),
];

const helpFaq = <HelpTopic>[
  HelpTopic(
    icon: LucideIcons.wifiOff,
    title: 'Thiết bị hiện "Ngoại tuyến"?',
    numbered: false,
    steps: [
      'Kiểm tra thiết bị còn điện và trong vùng phủ Wi-Fi.',
      'Trạng thái tự cập nhật khi thiết bị kết nối lại, thường trong vòng một phút.',
      'Xem mục Trạng thái hệ thống ở đầu trang này để biết máy chủ có đang hoạt động không.',
    ],
  ),
  HelpTopic(
    icon: LucideIcons.mailQuestion,
    title: 'Không thấy lời mời chia sẻ?',
    numbered: false,
    steps: [
      'Lời mời gắn với email: hãy đăng nhập đúng email mà chủ thiết bị đã nhập.',
      'Lời mời hết hạn sau 7 ngày hoặc khi chủ thiết bị hủy; khi đó hãy nhờ họ mời lại.',
    ],
  ),
  HelpTopic(
    icon: LucideIcons.logIn,
    title: 'Bị đưa về màn hình đăng nhập?',
    numbered: false,
    steps: [
      'Tài khoản đã được đăng xuất khỏi máy này từ một máy khác, hoặc mật khẩu vừa được đổi.',
      'Đăng nhập lại bằng mật khẩu hiện tại. Nếu bạn không làm việc đó, hãy đổi mật khẩu ngay.',
    ],
  ),
  HelpTopic(
    icon: LucideIcons.cameraOff,
    title: 'Không thấy bản ghi camera?',
    numbered: false,
    steps: [
      'Camera chỉ ghi khi có nguồn hình; phút đang ghi xem lại được sau vài giây.',
      'Đổi ngày ở thanh xem lại nếu bản ghi thuộc ngày khác, hoặc nhấn "Bản ghi mới nhất".',
    ],
  ),
];
