#pragma once

#include <cstdint>

enum class RiskLevel : std::uint8_t {
    Normal,
    Warning,
    Alarm,
    Emergency,
    SensorFault,
};

enum class AudibleState : std::uint8_t {
    Silent,
    Sounding,
    Muted,
};

enum class SirenCommandResult : std::uint8_t {
    Applied,
    InvalidDuration,
    ActiveHazard,
    NotSounding,
};

struct SirenSnapshot {
    RiskLevel risk = RiskLevel::SensorFault;
    AudibleState audible = AudibleState::Silent;
    std::uint64_t muteUntilEpochSeconds = 0;
};

class HazardSirenController {
public:
    void restoreMute(
        std::uint64_t muteUntilEpochSeconds,
        std::uint64_t nowEpochSeconds,
        std::uint64_t nowMillis
    );

    void setRisk(
        RiskLevel risk,
        std::uint64_t nowEpochSeconds,
        std::uint64_t nowMillis
    );

    SirenCommandResult startTest(
        std::uint16_t durationSeconds,
        std::uint64_t nowMillis
    );

    SirenCommandResult mute(
        std::uint16_t durationSeconds,
        std::uint64_t nowEpochSeconds,
        std::uint64_t nowMillis
    );

    void tick(std::uint64_t nowEpochSeconds, std::uint64_t nowMillis);

    const SirenSnapshot& snapshot() const { return snapshot_; }
    bool consumeChanged();

    static bool isAllowedMuteDuration(std::uint16_t durationSeconds);
    static const char* riskName(RiskLevel value);
    static const char* audibleName(AudibleState value);

private:
    SirenSnapshot snapshot_{};
    std::uint64_t muteUntilMillis_ = 0;
    std::uint64_t testUntilMillis_ = 0;
    bool changed_ = true;

    static bool isActiveHazard(RiskLevel risk);
    void reconcile(std::uint64_t nowEpochSeconds, std::uint64_t nowMillis);
    void setAudible(AudibleState value);
};
