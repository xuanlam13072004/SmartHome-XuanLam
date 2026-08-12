#include <unity.h>

#include "hazard_state_machine.h"

void setUp() {}
void tearDown() {}

void test_alarm_sounds_then_returns_after_bounded_mute() {
    HazardSirenController controller;
    controller.setRisk(RiskLevel::Alarm, 1'000, 10'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Sounding),
        static_cast<int>(controller.snapshot().audible)
    );

    TEST_ASSERT_EQUAL(
        static_cast<int>(SirenCommandResult::Applied),
        static_cast<int>(controller.mute(60, 1'000, 10'000))
    );
    TEST_ASSERT_EQUAL_UINT64(1'060, controller.snapshot().muteUntilEpochSeconds);

    controller.tick(1'061, 71'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Sounding),
        static_cast<int>(controller.snapshot().audible)
    );
    TEST_ASSERT_EQUAL_UINT64(0, controller.snapshot().muteUntilEpochSeconds);
}

void test_invalid_mute_duration_is_rejected() {
    HazardSirenController controller;
    controller.setRisk(RiskLevel::Alarm, 1'000, 10'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(SirenCommandResult::InvalidDuration),
        static_cast<int>(controller.mute(120, 1'000, 10'000))
    );
    TEST_ASSERT_TRUE(HazardSirenController::isAllowedMuteDuration(1800));
    TEST_ASSERT_FALSE(HazardSirenController::isAllowedMuteDuration(30));
}

void test_standby_siren_can_be_muted_before_a_hazard() {
    HazardSirenController controller;
    controller.setRisk(RiskLevel::Normal, 1'000, 10'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(SirenCommandResult::Applied),
        static_cast<int>(controller.mute(180, 1'000, 10'000))
    );
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Muted),
        static_cast<int>(controller.snapshot().audible)
    );
    TEST_ASSERT_EQUAL_UINT64(1'180, controller.snapshot().muteUntilEpochSeconds);

    controller.setRisk(RiskLevel::Emergency, 1'010, 20'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Muted),
        static_cast<int>(controller.snapshot().audible)
    );

    controller.tick(1'181, 191'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Sounding),
        static_cast<int>(controller.snapshot().audible)
    );
}

void test_muted_siren_can_be_rearmed_immediately() {
    HazardSirenController controller;
    controller.setRisk(RiskLevel::Normal, 1'000, 10'000);
    controller.mute(1800, 1'000, 10'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(SirenCommandResult::Applied),
        static_cast<int>(controller.resume(1'001, 11'000))
    );
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Silent),
        static_cast<int>(controller.snapshot().audible)
    );
    TEST_ASSERT_EQUAL_UINT64(0, controller.snapshot().muteUntilEpochSeconds);

    controller.setRisk(RiskLevel::Alarm, 1'002, 12'000);
    controller.mute(1800, 1'002, 12'000);
    controller.resume(1'003, 13'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Sounding),
        static_cast<int>(controller.snapshot().audible)
    );
    TEST_ASSERT_EQUAL_UINT64(0, controller.snapshot().muteUntilEpochSeconds);
}

void test_siren_test_is_bounded_and_disallowed_during_hazard() {
    HazardSirenController controller;
    controller.setRisk(RiskLevel::Normal, 1'000, 10'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(SirenCommandResult::Applied),
        static_cast<int>(controller.startTest(5, 10'000))
    );
    controller.tick(1'006, 15'001);
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Silent),
        static_cast<int>(controller.snapshot().audible)
    );

    controller.setRisk(RiskLevel::Emergency, 1'006, 16'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(SirenCommandResult::ActiveHazard),
        static_cast<int>(controller.startTest(5, 16'000))
    );
}

void test_restore_never_extends_an_expired_mute() {
    HazardSirenController controller;
    controller.setRisk(RiskLevel::Alarm, 1'000, 10'000);
    controller.restoreMute(999, 1'000, 10'000);
    TEST_ASSERT_EQUAL(
        static_cast<int>(AudibleState::Sounding),
        static_cast<int>(controller.snapshot().audible)
    );
    TEST_ASSERT_EQUAL_UINT64(0, controller.snapshot().muteUntilEpochSeconds);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_alarm_sounds_then_returns_after_bounded_mute);
    RUN_TEST(test_invalid_mute_duration_is_rejected);
    RUN_TEST(test_standby_siren_can_be_muted_before_a_hazard);
    RUN_TEST(test_muted_siren_can_be_rearmed_immediately);
    RUN_TEST(test_siren_test_is_bounded_and_disallowed_during_hazard);
    RUN_TEST(test_restore_never_extends_an_expired_mute);
    return UNITY_END();
}
