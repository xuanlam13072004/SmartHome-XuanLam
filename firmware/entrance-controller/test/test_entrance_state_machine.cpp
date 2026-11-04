#include <unity.h>

#include <cstring>

#include "entrance_state_machine.h"

namespace {

EntranceController bootLocked() {
    EntranceController controller;
    controller.boot(true, EntranceSensorState::Ready, 0.0F, 0);
    return controller;
}

void enterPin(EntranceController& controller, const char* pin, std::uint64_t now = 1'000) {
    if (controller.snapshot().phase == EntrancePhase::Idle) {
        TEST_ASSERT_EQUAL_INT(
            static_cast<int>(EntranceActionResult::Applied),
            static_cast<int>(controller.handleKey('A', now))
        );
    } else {
        TEST_ASSERT_EQUAL_INT(
            static_cast<int>(EntrancePhase::PinEntry),
            static_cast<int>(controller.snapshot().phase)
        );
    }
    for (std::size_t index = 0; pin[index] != '\0'; ++index) {
        controller.handleKey(pin[index], now + index + 1);
    }
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceActionResult::PinVerificationRequired),
        static_cast<int>(controller.handleKey('#', now + 10))
    );
}

}  // namespace

void setUp() {}
void tearDown() {}

void test_boot_is_locked_and_shows_the_four_line_idle_contract() {
    auto controller = bootLocked();
    const auto& snapshot = controller.snapshot();
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Locked),
        static_cast<int>(snapshot.lockState)
    );
    TEST_ASSERT_EQUAL_STRING("Xin chao!", snapshot.lcdLines[0].data());
    TEST_ASSERT_EQUAL_STRING("Cua dang khoa", snapshot.lcdLines[1].data());
    TEST_ASSERT_EQUAL_STRING("Nhan A de mo khoa", snapshot.lcdLines[2].data());
    TEST_ASSERT_EQUAL_STRING("", snapshot.lcdLines[3].data());
}

void test_boot_with_a_healthy_open_door_is_not_reported_as_sensor_fault() {
    EntranceController controller;
    controller.boot(
        true,
        EntranceSensorState::Ready,
        45.0F,
        0,
        EntranceLockState::Locked
    );
    const auto& snapshot = controller.snapshot();
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Unlocked),
        static_cast<int>(snapshot.lockState)
    );
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::DoorOpen),
        static_cast<int>(snapshot.phase)
    );
    TEST_ASSERT_EQUAL_STRING("firmware", snapshot.displaySource.data());
    TEST_ASSERT_EQUAL_STRING("CUA DANG MO", snapshot.lcdLines[0].data());
}

void test_correct_pin_unlocks_then_relocks_after_thirty_seconds_if_unopened() {
    auto controller = bootLocked();
    enterPin(controller, "012345");
    TEST_ASSERT_EQUAL_STRING("012345", controller.enteredPin());
    controller.completePinVerification(true, 1'020);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Unlocking),
        static_cast<int>(controller.snapshot().lockState)
    );
    TEST_ASSERT_EQUAL_STRING("", controller.enteredPin());

    controller.tick(1'520);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::UnlockedWaitOpen),
        static_cast<int>(controller.snapshot().phase)
    );
    controller.updateDoorPosition(0.0F, EntranceSensorState::Ready, 2'000);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::UnlockedWaitOpen),
        static_cast<int>(controller.snapshot().phase)
    );
    controller.tick(31'519);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Unlocked),
        static_cast<int>(controller.snapshot().lockState)
    );
    controller.tick(31'520);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Locking),
        static_cast<int>(controller.snapshot().lockState)
    );
    controller.tick(32'020);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Locked),
        static_cast<int>(controller.snapshot().lockState)
    );
}

void test_open_close_requires_three_continuous_seconds_before_relock() {
    auto controller = bootLocked();
    enterPin(controller, "012345");
    controller.completePinVerification(true, 1'020);
    controller.tick(1'520);
    controller.updateDoorPosition(45.0F, EntranceSensorState::Ready, 2'000);
    controller.updateDoorPosition(0.0F, EntranceSensorState::Ready, 3'000);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::ClosedWaitRelock),
        static_cast<int>(controller.snapshot().phase)
    );

    // Repeated closed sensor samples must not push the deadline forward.
    controller.updateDoorPosition(0.0F, EntranceSensorState::Ready, 4'000);
    controller.updateDoorPosition(0.0F, EntranceSensorState::Ready, 5'000);
    controller.tick(5'999);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Unlocked),
        static_cast<int>(controller.snapshot().lockState)
    );
    controller.tick(6'000);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Locking),
        static_cast<int>(controller.snapshot().lockState)
    );
}

void test_door_movement_during_unlock_does_not_cancel_servo_completion() {
    auto controller = bootLocked();
    enterPin(controller, "012345");
    controller.completePinVerification(true, 1'020);
    controller.updateDoorPosition(45.0F, EntranceSensorState::Ready, 1'200);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::Unlocking),
        static_cast<int>(controller.snapshot().phase)
    );
    controller.tick(1'520);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::DoorOpen),
        static_cast<int>(controller.snapshot().phase)
    );
    controller.tick(40'000);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Unlocked),
        static_cast<int>(controller.snapshot().lockState)
    );
}

void test_sensor_fault_during_unlock_keeps_lock_open_without_auto_relock() {
    auto controller = bootLocked();
    enterPin(controller, "012345");
    controller.completePinVerification(true, 1'020);
    controller.updateDoorPosition(0.0F, EntranceSensorState::Fault, 1'200);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::Unlocking),
        static_cast<int>(controller.snapshot().phase)
    );

    controller.tick(1'520);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Unlocked),
        static_cast<int>(controller.snapshot().lockState)
    );
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::SensorFault),
        static_cast<int>(controller.snapshot().phase)
    );
    TEST_ASSERT_EQUAL_STRING("safety", controller.snapshot().displaySource.data());

    controller.tick(40'000);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceLockState::Unlocked),
        static_cast<int>(controller.snapshot().lockState)
    );
}

void test_lock_is_rejected_when_door_is_open_or_sensor_is_faulted() {
    auto controller = bootLocked();
    controller.requestUnlock(EntranceSource::Remote, "test", 1'000);
    controller.tick(1'500);
    controller.updateDoorPosition(45.0F, EntranceSensorState::Ready, 2'000);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceActionResult::UnsafeDoorPosition),
        static_cast<int>(controller.requestLock(EntranceSource::Remote, "test", 2'100))
    );
    controller.updateDoorPosition(0.0F, EntranceSensorState::Fault, 2'200);
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceActionResult::UnsafeDoorPosition),
        static_cast<int>(controller.requestLock(EntranceSource::Remote, "test", 2'300))
    );
}

void test_three_wrong_pins_lock_the_keypad_without_keeping_pin_in_memory() {
    auto controller = bootLocked();
    for (int attempt = 0; attempt < 3; ++attempt) {
        enterPin(controller, "999999", 1'000 + attempt * 100);
        controller.completePinVerification(false, 1'020 + attempt * 100);
        TEST_ASSERT_EQUAL_STRING("", controller.enteredPin());
    }
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntrancePhase::PinLockedOut),
        static_cast<int>(controller.snapshot().phase)
    );
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(EntranceActionResult::KeypadLockedOut),
        static_cast<int>(controller.handleKey('A', 1'500))
    );
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_boot_is_locked_and_shows_the_four_line_idle_contract);
    RUN_TEST(test_boot_with_a_healthy_open_door_is_not_reported_as_sensor_fault);
    RUN_TEST(test_correct_pin_unlocks_then_relocks_after_thirty_seconds_if_unopened);
    RUN_TEST(test_open_close_requires_three_continuous_seconds_before_relock);
    RUN_TEST(test_door_movement_during_unlock_does_not_cancel_servo_completion);
    RUN_TEST(test_sensor_fault_during_unlock_keeps_lock_open_without_auto_relock);
    RUN_TEST(test_lock_is_rejected_when_door_is_open_or_sensor_is_faulted);
    RUN_TEST(test_three_wrong_pins_lock_the_keypad_without_keeping_pin_in_memory);
    return UNITY_END();
}
