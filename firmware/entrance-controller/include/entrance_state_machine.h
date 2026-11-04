#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

enum class EntranceLockState : std::uint8_t {
    Locked,
    Unlocking,
    Unlocked,
    Locking,
    Fault,
};

enum class EntranceDoorState : std::uint8_t {
    Closed,
    Opening,
    Open,
    Closing,
    Unknown,
};

enum class EntranceSensorState : std::uint8_t {
    Calibrating,
    Ready,
    Fault,
};

enum class EntrancePhase : std::uint8_t {
    Idle,
    PinEntry,
    Unlocking,
    UnlockedWaitOpen,
    DoorOpen,
    ClosedWaitRelock,
    Locking,
    SensorFault,
    PinLockedOut,
};

enum class EntranceSource : std::uint8_t {
    Keypad,
    Face,
    Remote,
    Automatic,
    BootRecovery,
    Unknown,
};

enum class EntranceActionResult : std::uint8_t {
    Ignored,
    Applied,
    PinVerificationRequired,
    PinIncomplete,
    KeypadLockedOut,
    PinNotConfigured,
    UnsafeDoorPosition,
};

enum class EntranceEventType : std::uint8_t {
    None,
    KeypadAuthenticationRequested,
    KeypadAuthenticationCancelled,
    KeypadAuthenticationSubmitted,
    PinAccessGranted,
    PinAccessDenied,
    PinLockedOut,
    LockChanged,
    DoorOpened,
    DoorClosed,
    DoorPositionFault,
};

struct EntranceEvent {
    EntranceEventType type = EntranceEventType::None;
    EntranceLockState lockState = EntranceLockState::Fault;
    EntranceSource source = EntranceSource::Unknown;
    std::uint8_t attemptsRemaining = 0;
    float angleDegrees = 0.0F;
    std::uint64_t deadlineMillis = 0;
    std::array<char, 65> reason{};
};

struct EntranceSnapshot {
    EntranceLockState lockState = EntranceLockState::Fault;
    EntranceDoorState doorState = EntranceDoorState::Unknown;
    EntranceSensorState sensorState = EntranceSensorState::Calibrating;
    EntrancePhase phase = EntrancePhase::SensorFault;
    EntranceSource actuatorSource = EntranceSource::Unknown;
    float doorAngleDegrees = 0.0F;
    bool pinConfigured = false;
    std::uint8_t attemptsRemaining = 3;
    std::uint64_t lockoutUntilMillis = 0;
    std::array<std::array<char, 21>, 4> lcdLines{};
    std::array<char, 16> displaySource{};
};

class EntranceController {
public:
    static constexpr std::uint64_t ServoTransitionMs = 500;
    static constexpr std::uint64_t UnlockWaitMs = 30'000;
    static constexpr std::uint64_t ClosedRelockMs = 3'000;
    static constexpr std::uint64_t PinLockoutMs = 30'000;
    static constexpr float DoorClosedDegrees = 4.0F;
    static constexpr float DoorOpenDegrees = 12.0F;

    void boot(
        bool pinConfigured,
        EntranceSensorState sensorState,
        float angleDegrees,
        std::uint64_t nowMillis,
        EntranceLockState preferredStableState = EntranceLockState::Locked
    );

    EntranceActionResult handleKey(char key, std::uint64_t nowMillis);
    const char* enteredPin() const { return pinBuffer_.data(); }
    std::size_t enteredPinLength() const { return pinLength_; }
    EntranceActionResult completePinVerification(bool matches, std::uint64_t nowMillis);
    void setPinConfigured(bool configured);

    EntranceActionResult requestLock(
        EntranceSource source,
        const char* reason,
        std::uint64_t nowMillis
    );
    EntranceActionResult requestUnlock(
        EntranceSource source,
        const char* reason,
        std::uint64_t nowMillis
    );

    void updateDoorPosition(
        float angleDegrees,
        EntranceSensorState sensorState,
        std::uint64_t nowMillis
    );
    void tick(std::uint64_t nowMillis);

    void setCustomDisplay(const std::array<std::array<char, 21>, 4>& lines);
    void clearCustomDisplay();

    const EntranceSnapshot& snapshot() const { return snapshot_; }
    bool consumeChanged();
    bool popEvent(EntranceEvent& event);

    static const char* lockStateName(EntranceLockState value);
    static const char* doorStateName(EntranceDoorState value);
    static const char* sensorStateName(EntranceSensorState value);
    static const char* phaseName(EntrancePhase value);
    static const char* sourceName(EntranceSource value);

private:
    EntranceSnapshot snapshot_{};
    std::array<char, 7> pinBuffer_{};
    std::size_t pinLength_ = 0;
    bool pinVerificationPending_ = false;
    bool doorOpenedSinceUnlock_ = false;
    bool customDisplayEnabled_ = false;
    std::array<std::array<char, 21>, 4> customDisplay_{};
    std::uint64_t servoDeadlineMillis_ = 0;
    std::uint64_t unlockDeadlineMillis_ = 0;
    std::uint64_t closedDeadlineMillis_ = 0;
    std::array<EntranceEvent, 16> events_{};
    std::size_t eventHead_ = 0;
    std::size_t eventCount_ = 0;
    bool changed_ = true;

    void beginLock(EntranceSource source, const char* reason, std::uint64_t nowMillis);
    void beginUnlock(EntranceSource source, const char* reason, std::uint64_t nowMillis);
    void clearPinBuffer();
    bool keypadLocked(std::uint64_t nowMillis);
    bool safeToLock() const;
    void showIdle();
    void showPinEntry(const char* heading = "NHAP MA PIN");
    void setDisplay(
        const char* source,
        const char* line1,
        const char* line2,
        const char* line3,
        const char* line4
    );
    void pushEvent(
        EntranceEventType type,
        const char* reason = "",
        EntranceSource source = EntranceSource::Unknown
    );
    void markChanged();
};
