#include "hazard_state_machine.h"

namespace {

constexpr std::uint64_t millisForSeconds(std::uint16_t value) {
    return static_cast<std::uint64_t>(value) * 1000ULL;
}

}  // namespace

bool HazardSirenController::isAllowedMuteDuration(std::uint16_t durationSeconds) {
    return durationSeconds == 30
        || durationSeconds == 60
        || durationSeconds == 180
        || durationSeconds == 300;
}

bool HazardSirenController::isActiveHazard(RiskLevel risk) {
    return risk == RiskLevel::Alarm || risk == RiskLevel::Emergency;
}

void HazardSirenController::restoreMute(
    std::uint64_t muteUntilEpochSeconds,
    std::uint64_t nowEpochSeconds,
    std::uint64_t nowMillis
) {
    if (
        muteUntilEpochSeconds == 0
        || nowEpochSeconds == 0
        || muteUntilEpochSeconds <= nowEpochSeconds
    ) {
        snapshot_.muteUntilEpochSeconds = 0;
        muteUntilMillis_ = 0;
    } else {
        snapshot_.muteUntilEpochSeconds = muteUntilEpochSeconds;
        muteUntilMillis_ = nowMillis
            + ((muteUntilEpochSeconds - nowEpochSeconds) * 1000ULL);
    }
    reconcile(nowEpochSeconds, nowMillis);
}

void HazardSirenController::setRisk(
    RiskLevel risk,
    std::uint64_t nowEpochSeconds,
    std::uint64_t nowMillis
) {
    if (snapshot_.risk != risk) {
        snapshot_.risk = risk;
        changed_ = true;
    }
    if (isActiveHazard(risk)) testUntilMillis_ = 0;
    reconcile(nowEpochSeconds, nowMillis);
}

SirenCommandResult HazardSirenController::startTest(
    std::uint16_t durationSeconds,
    std::uint64_t nowMillis
) {
    if (durationSeconds < 1 || durationSeconds > 30) {
        return SirenCommandResult::InvalidDuration;
    }
    if (isActiveHazard(snapshot_.risk)) {
        return SirenCommandResult::ActiveHazard;
    }
    testUntilMillis_ = nowMillis + millisForSeconds(durationSeconds);
    setAudible(AudibleState::Sounding);
    return SirenCommandResult::Applied;
}

SirenCommandResult HazardSirenController::mute(
    std::uint16_t durationSeconds,
    std::uint64_t nowEpochSeconds,
    std::uint64_t nowMillis
) {
    if (!isAllowedMuteDuration(durationSeconds)) {
        return SirenCommandResult::InvalidDuration;
    }
    if (snapshot_.audible != AudibleState::Sounding) {
        return SirenCommandResult::NotSounding;
    }
    testUntilMillis_ = 0;
    muteUntilMillis_ = nowMillis + millisForSeconds(durationSeconds);
    snapshot_.muteUntilEpochSeconds = nowEpochSeconds == 0
        ? 0
        : nowEpochSeconds + durationSeconds;
    changed_ = true;
    setAudible(AudibleState::Muted);
    return SirenCommandResult::Applied;
}

void HazardSirenController::tick(
    std::uint64_t nowEpochSeconds,
    std::uint64_t nowMillis
) {
    reconcile(nowEpochSeconds, nowMillis);
}

void HazardSirenController::reconcile(
    std::uint64_t nowEpochSeconds,
    std::uint64_t nowMillis
) {
    const bool muteActive = muteUntilMillis_ != 0 && nowMillis < muteUntilMillis_;
    const bool testActive = testUntilMillis_ != 0 && nowMillis < testUntilMillis_;

    if (!muteActive && (muteUntilMillis_ != 0 || snapshot_.muteUntilEpochSeconds != 0)) {
        muteUntilMillis_ = 0;
        snapshot_.muteUntilEpochSeconds = 0;
        changed_ = true;
    } else if (
        muteActive
        && nowEpochSeconds != 0
        && snapshot_.muteUntilEpochSeconds == 0
    ) {
        const auto remainingMillis = muteUntilMillis_ - nowMillis;
        snapshot_.muteUntilEpochSeconds = nowEpochSeconds
            + ((remainingMillis + 999ULL) / 1000ULL);
        changed_ = true;
    }

    if (!testActive) testUntilMillis_ = 0;

    if (isActiveHazard(snapshot_.risk)) {
        setAudible(muteActive ? AudibleState::Muted : AudibleState::Sounding);
    } else if (testActive) {
        setAudible(AudibleState::Sounding);
    } else {
        setAudible(AudibleState::Silent);
    }
}

void HazardSirenController::setAudible(AudibleState value) {
    if (snapshot_.audible == value) return;
    snapshot_.audible = value;
    changed_ = true;
}

bool HazardSirenController::consumeChanged() {
    const bool result = changed_;
    changed_ = false;
    return result;
}

const char* HazardSirenController::riskName(RiskLevel value) {
    switch (value) {
        case RiskLevel::Normal: return "normal";
        case RiskLevel::Warning: return "warning";
        case RiskLevel::Alarm: return "alarm";
        case RiskLevel::Emergency: return "emergency";
        case RiskLevel::SensorFault: return "sensor_fault";
    }
    return "sensor_fault";
}

const char* HazardSirenController::audibleName(AudibleState value) {
    switch (value) {
        case AudibleState::Silent: return "silent";
        case AudibleState::Sounding: return "sounding";
        case AudibleState::Muted: return "muted";
    }
    return "silent";
}
