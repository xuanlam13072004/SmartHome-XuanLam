#include "entrance_state_machine.h"

#include <algorithm>
#include <cstdio>
#include <cmath>
#include <cstring>

namespace {

template <std::size_t Size>
void copyText(std::array<char, Size>& target, const char* value) {
    target.fill('\0');
    if (!value) return;
    std::strncpy(target.data(), value, Size - 1);
}

}  // namespace

void EntranceController::boot(
    bool pinConfigured,
    EntranceSensorState sensorState,
    float angleDegrees,
    std::uint64_t nowMillis,
    EntranceLockState preferredStableState
) {
    snapshot_ = {};
    snapshot_.pinConfigured = pinConfigured;
    snapshot_.attemptsRemaining = 3;
    snapshot_.sensorState = sensorState;
    snapshot_.doorAngleDegrees = std::clamp(angleDegrees, 0.0F, 180.0F);
    snapshot_.doorState = sensorState == EntranceSensorState::Ready
        ? (snapshot_.doorAngleDegrees <= DoorClosedDegrees
            ? EntranceDoorState::Closed
            : EntranceDoorState::Open)
        : EntranceDoorState::Unknown;
    clearPinBuffer();
    pinVerificationPending_ = false;
    doorOpenedSinceUnlock_ = false;
    servoDeadlineMillis_ = 0;
    unlockDeadlineMillis_ = 0;
    closedDeadlineMillis_ = 0;
    snapshot_.lockoutUntilMillis = 0;
    eventHead_ = 0;
    eventCount_ = 0;

    if (safeToLock()) {
        snapshot_.actuatorSource = EntranceSource::BootRecovery;
        if (preferredStableState == EntranceLockState::Unlocked) {
            snapshot_.lockState = EntranceLockState::Unlocked;
            snapshot_.phase = EntrancePhase::UnlockedWaitOpen;
            unlockDeadlineMillis_ = nowMillis + UnlockWaitMs;
            setDisplay(
                "authentication",
                "DA MO KHOA",
                "Mo cua trong 30 giay",
                "Se tu dong khoa",
                ""
            );
        } else {
            snapshot_.lockState = EntranceLockState::Locked;
            snapshot_.phase = EntrancePhase::Idle;
            showIdle();
        }
    } else {
        snapshot_.lockState = EntranceLockState::Unlocked;
        snapshot_.phase = sensorState == EntranceSensorState::Ready
            ? EntrancePhase::DoorOpen
            : EntrancePhase::SensorFault;
        snapshot_.actuatorSource = EntranceSource::BootRecovery;
        if (sensorState == EntranceSensorState::Calibrating) {
            setDisplay(
                "safety",
                "CAN HIEU CHUAN CUA",
                "Dong cua hoan toan",
                "Nhan D de xac nhan",
                ""
            );
        } else if (sensorState == EntranceSensorState::Fault) {
            setDisplay(
                "safety",
                "LOI CAM BIEN CUA",
                "Khong tu dong khoa",
                "Kiem tra MPU6050",
                ""
            );
        } else {
            setDisplay(
                "firmware",
                "CUA DANG MO",
                "Khoa dang mo",
                "Dong cua de tu khoa",
                ""
            );
        }
    }
    markChanged();
}

EntranceActionResult EntranceController::handleKey(char key, std::uint64_t nowMillis) {
    if (key >= 'a' && key <= 'd') key = static_cast<char>(key - 'a' + 'A');
    if (keypadLocked(nowMillis)) return EntranceActionResult::KeypadLockedOut;

    if (snapshot_.phase == EntrancePhase::Idle) {
        if (key != 'A') return EntranceActionResult::Ignored;
        if (!snapshot_.pinConfigured) {
            setDisplay(
                "safety",
                "CHUA CO MA PIN",
                "Cau hinh tren app",
                "Cua van dang khoa",
                ""
            );
            markChanged();
            return EntranceActionResult::PinNotConfigured;
        }
        if (snapshot_.lockState != EntranceLockState::Locked) {
            return EntranceActionResult::Ignored;
        }
        clearPinBuffer();
        snapshot_.phase = EntrancePhase::PinEntry;
        showPinEntry();
        pushEvent(EntranceEventType::KeypadAuthenticationRequested);
        markChanged();
        return EntranceActionResult::Applied;
    }

    if (snapshot_.phase != EntrancePhase::PinEntry) return EntranceActionResult::Ignored;
    if (key >= '0' && key <= '9') {
        if (pinLength_ < 6) {
            pinBuffer_[pinLength_++] = key;
            pinBuffer_[pinLength_] = '\0';
        }
        showPinEntry();
        markChanged();
        return EntranceActionResult::Applied;
    }
    if (key == '*') {
        if (pinLength_ > 0) {
            pinBuffer_[--pinLength_] = '\0';
            showPinEntry();
        } else {
            snapshot_.phase = EntrancePhase::Idle;
            pushEvent(EntranceEventType::KeypadAuthenticationCancelled);
            showIdle();
        }
        markChanged();
        return EntranceActionResult::Applied;
    }
    if (key != '#') return EntranceActionResult::Ignored;
    if (pinLength_ != 6) {
        showPinEntry("CAN DU 6 CHU SO");
        markChanged();
        return EntranceActionResult::PinIncomplete;
    }
    pinVerificationPending_ = true;
    pushEvent(EntranceEventType::KeypadAuthenticationSubmitted);
    return EntranceActionResult::PinVerificationRequired;
}

EntranceActionResult EntranceController::completePinVerification(
    bool matches,
    std::uint64_t nowMillis
) {
    if (!pinVerificationPending_ || snapshot_.phase != EntrancePhase::PinEntry) {
        return EntranceActionResult::Ignored;
    }
    pinVerificationPending_ = false;
    clearPinBuffer();
    if (matches) {
        snapshot_.attemptsRemaining = 3;
        pushEvent(EntranceEventType::PinAccessGranted, "primary");
        beginUnlock(EntranceSource::Keypad, "pin_verified", nowMillis);
        return EntranceActionResult::Applied;
    }

    snapshot_.attemptsRemaining = snapshot_.attemptsRemaining > 0
        ? static_cast<std::uint8_t>(snapshot_.attemptsRemaining - 1)
        : 0;
    pushEvent(EntranceEventType::PinAccessDenied);
    if (snapshot_.attemptsRemaining == 0) {
        snapshot_.phase = EntrancePhase::PinLockedOut;
        snapshot_.lockoutUntilMillis = nowMillis + PinLockoutMs;
        setDisplay(
            "safety",
            "BAN PHIM TAM KHOA",
            "Sai ma qua nhieu lan",
            "Thu lai sau 30 giay",
            ""
        );
        pushEvent(EntranceEventType::PinLockedOut);
    } else {
        char attempts[21]{};
        std::snprintf(
            attempts,
            sizeof(attempts),
            "Con %u lan thu",
            static_cast<unsigned>(snapshot_.attemptsRemaining)
        );
        setDisplay(
            "authentication",
            "MA PIN KHONG DUNG",
            attempts,
            "Nhap lai ma PIN",
            "#: Xac nhan"
        );
    }
    markChanged();
    return EntranceActionResult::Applied;
}

void EntranceController::setPinConfigured(bool configured) {
    if (snapshot_.pinConfigured == configured) return;
    snapshot_.pinConfigured = configured;
    if (snapshot_.phase == EntrancePhase::Idle) showIdle();
    markChanged();
}

EntranceActionResult EntranceController::requestLock(
    EntranceSource source,
    const char* reason,
    std::uint64_t nowMillis
) {
    if (!safeToLock()) return EntranceActionResult::UnsafeDoorPosition;
    if (snapshot_.lockState == EntranceLockState::Locked) {
        snapshot_.phase = EntrancePhase::Idle;
        clearPinBuffer();
        showIdle();
        markChanged();
        return EntranceActionResult::Applied;
    }
    beginLock(source, reason, nowMillis);
    return EntranceActionResult::Applied;
}

EntranceActionResult EntranceController::requestUnlock(
    EntranceSource source,
    const char* reason,
    std::uint64_t nowMillis
) {
    if (snapshot_.lockState == EntranceLockState::Unlocked) {
        return EntranceActionResult::Applied;
    }
    beginUnlock(source, reason, nowMillis);
    return EntranceActionResult::Applied;
}

void EntranceController::updateDoorPosition(
    float angleDegrees,
    EntranceSensorState sensorState,
    std::uint64_t nowMillis
) {
    const auto previousDoorState = snapshot_.doorState;
    const auto previousAngle = snapshot_.doorAngleDegrees;
    const auto previousSensorState = snapshot_.sensorState;
    const auto previousPhase = snapshot_.phase;
    const auto previousEventCount = eventCount_;
    snapshot_.doorAngleDegrees = std::clamp(angleDegrees, 0.0F, 180.0F);
    snapshot_.sensorState = sensorState;

    if (sensorState != EntranceSensorState::Ready) {
        snapshot_.doorState = EntranceDoorState::Unknown;
        if (
            snapshot_.phase != EntrancePhase::Unlocking
            && snapshot_.phase != EntrancePhase::Locking
        ) {
            snapshot_.phase = EntrancePhase::SensorFault;
        }
        unlockDeadlineMillis_ = 0;
        closedDeadlineMillis_ = 0;
        setDisplay(
            "safety",
            "LOI CAM BIEN CUA",
            "Khong tu dong khoa",
            "Kiem tra MPU6050",
            ""
        );
        if (previousSensorState == EntranceSensorState::Ready) {
            pushEvent(EntranceEventType::DoorPositionFault, "mpu6050_unavailable");
        }
        if (
            previousSensorState != snapshot_.sensorState
            || previousDoorState != snapshot_.doorState
            || previousPhase != snapshot_.phase
            || previousEventCount != eventCount_
        ) {
            markChanged();
        }
        return;
    }

    if (snapshot_.doorAngleDegrees <= DoorClosedDegrees) {
        snapshot_.doorState = EntranceDoorState::Closed;
    } else if (snapshot_.doorAngleDegrees >= DoorOpenDegrees) {
        snapshot_.doorState = EntranceDoorState::Open;
    } else if (snapshot_.doorAngleDegrees > previousAngle) {
        snapshot_.doorState = EntranceDoorState::Opening;
    } else if (snapshot_.doorAngleDegrees < previousAngle) {
        snapshot_.doorState = EntranceDoorState::Closing;
    } else {
        snapshot_.doorState = EntranceDoorState::Unknown;
    }

    if (snapshot_.doorState != EntranceDoorState::Closed) {
        unlockDeadlineMillis_ = 0;
        closedDeadlineMillis_ = 0;
        if (
            snapshot_.phase != EntrancePhase::Unlocking
            && snapshot_.phase != EntrancePhase::Locking
        ) {
            snapshot_.phase = EntrancePhase::DoorOpen;
        }
        if (snapshot_.lockState == EntranceLockState::Unlocked) {
            doorOpenedSinceUnlock_ = true;
        }
    }
    if (snapshot_.doorState == EntranceDoorState::Open) {
        setDisplay(
            "firmware",
            "CUA DANG MO",
            "Khoa dang mo",
            "Dong cua de tu khoa",
            ""
        );
        if (previousDoorState != EntranceDoorState::Open) {
            pushEvent(EntranceEventType::DoorOpened);
            if (snapshot_.lockState == EntranceLockState::Locked) {
                pushEvent(EntranceEventType::DoorPositionFault, "door_moved_while_locked");
            }
        }
    } else if (snapshot_.doorState == EntranceDoorState::Closed) {
        if (previousDoorState != EntranceDoorState::Closed) {
            pushEvent(EntranceEventType::DoorClosed);
        }
        if (
            snapshot_.lockState == EntranceLockState::Unlocked
            && doorOpenedSinceUnlock_
            && snapshot_.phase != EntrancePhase::ClosedWaitRelock
        ) {
            snapshot_.phase = EntrancePhase::ClosedWaitRelock;
            closedDeadlineMillis_ = nowMillis + ClosedRelockMs;
            setDisplay(
                "authentication",
                "CUA DA DONG",
                "Tu khoa sau 3 giay",
                "Vui long doi",
                ""
            );
        } else if (
            snapshot_.lockState == EntranceLockState::Unlocked
            && snapshot_.phase == EntrancePhase::SensorFault
        ) {
            // A sensor recovery cannot prove whether the door moved while the
            // measurement was unavailable. Use the short, safe closed debounce.
            doorOpenedSinceUnlock_ = true;
            snapshot_.phase = EntrancePhase::ClosedWaitRelock;
            closedDeadlineMillis_ = nowMillis + ClosedRelockMs;
            setDisplay(
                "safety",
                "CAM BIEN DA SAN SANG",
                "Tu khoa sau 3 giay",
                "Vui long doi",
                ""
            );
        } else if (
            snapshot_.lockState == EntranceLockState::Locked
            && snapshot_.phase != EntrancePhase::Locking
        ) {
            snapshot_.phase = EntrancePhase::Idle;
            showIdle();
        }
    }
    if (
        previousSensorState != snapshot_.sensorState
        || previousDoorState != snapshot_.doorState
        || previousPhase != snapshot_.phase
        || std::fabs(previousAngle - snapshot_.doorAngleDegrees) >= 0.5F
        || previousEventCount != eventCount_
    ) {
        markChanged();
    }
}

void EntranceController::tick(std::uint64_t nowMillis) {
    keypadLocked(nowMillis);
    if (
        servoDeadlineMillis_ != 0
        && nowMillis >= servoDeadlineMillis_
        && snapshot_.phase == EntrancePhase::Unlocking
    ) {
        servoDeadlineMillis_ = 0;
        snapshot_.lockState = EntranceLockState::Unlocked;
        const bool sensorReady = snapshot_.sensorState == EntranceSensorState::Ready;
        const bool doorAlreadyMoved = sensorReady
            && snapshot_.doorState != EntranceDoorState::Closed;
        doorOpenedSinceUnlock_ = doorAlreadyMoved || doorOpenedSinceUnlock_;
        snapshot_.phase = !sensorReady
            ? EntrancePhase::SensorFault
            : doorAlreadyMoved
                ? EntrancePhase::DoorOpen
                : EntrancePhase::UnlockedWaitOpen;
        if (!sensorReady) {
            unlockDeadlineMillis_ = 0;
            setDisplay(
                "safety",
                "LOI CAM BIEN CUA",
                "Khoa da mo an toan",
                "Khong tu dong khoa",
                ""
            );
        } else if (doorAlreadyMoved) {
            unlockDeadlineMillis_ = 0;
            setDisplay(
                "firmware",
                "CUA DANG MO",
                "Khoa dang mo",
                "Dong cua de tu khoa",
                ""
            );
        } else {
            unlockDeadlineMillis_ = nowMillis + UnlockWaitMs;
            setDisplay(
                "authentication",
                "DA MO KHOA",
                "Mo cua trong 30 giay",
                "Se tu dong khoa",
                ""
            );
        }
        pushEvent(
            EntranceEventType::LockChanged,
            "servo_completed",
            snapshot_.actuatorSource
        );
        markChanged();
    }
    if (
        unlockDeadlineMillis_ != 0
        && nowMillis >= unlockDeadlineMillis_
        && snapshot_.phase == EntrancePhase::UnlockedWaitOpen
    ) {
        unlockDeadlineMillis_ = 0;
        if (safeToLock()) beginLock(EntranceSource::Automatic, "door_not_opened_30s", nowMillis);
    }
    if (
        closedDeadlineMillis_ != 0
        && nowMillis >= closedDeadlineMillis_
        && snapshot_.phase == EntrancePhase::ClosedWaitRelock
    ) {
        closedDeadlineMillis_ = 0;
        if (safeToLock()) beginLock(EntranceSource::Automatic, "door_closed_stable_3s", nowMillis);
    }
    if (
        servoDeadlineMillis_ != 0
        && nowMillis >= servoDeadlineMillis_
        && snapshot_.phase == EntrancePhase::Locking
    ) {
        servoDeadlineMillis_ = 0;
        if (!safeToLock()) {
            snapshot_.lockState = EntranceLockState::Unlocked;
            snapshot_.phase = EntrancePhase::SensorFault;
            setDisplay(
                "safety",
                "KHONG THE KHOA CUA",
                "Cua chua dong an toan",
                "",
                ""
            );
            markChanged();
            return;
        }
        snapshot_.lockState = EntranceLockState::Locked;
        snapshot_.phase = EntrancePhase::Idle;
        doorOpenedSinceUnlock_ = false;
        pushEvent(
            EntranceEventType::LockChanged,
            "servo_completed",
            snapshot_.actuatorSource
        );
        snapshot_.actuatorSource = EntranceSource::Unknown;
        showIdle();
        markChanged();
    }
}

void EntranceController::setCustomDisplay(
    const std::array<std::array<char, 21>, 4>& lines
) {
    customDisplay_ = lines;
    for (auto& line : customDisplay_) line[20] = '\0';
    customDisplayEnabled_ = true;
    if (snapshot_.phase == EntrancePhase::Idle) showIdle();
    markChanged();
}

void EntranceController::clearCustomDisplay() {
    customDisplayEnabled_ = false;
    customDisplay_ = {};
    if (snapshot_.phase == EntrancePhase::Idle) showIdle();
    markChanged();
}

bool EntranceController::consumeChanged() {
    const bool result = changed_;
    changed_ = false;
    return result;
}

bool EntranceController::popEvent(EntranceEvent& event) {
    if (eventCount_ == 0) return false;
    event = events_[eventHead_];
    eventHead_ = (eventHead_ + 1) % events_.size();
    --eventCount_;
    return true;
}

void EntranceController::beginLock(
    EntranceSource source,
    const char* reason,
    std::uint64_t nowMillis
) {
    if (!safeToLock()) return;
    clearPinBuffer();
    pinVerificationPending_ = false;
    doorOpenedSinceUnlock_ = false;
    unlockDeadlineMillis_ = 0;
    closedDeadlineMillis_ = 0;
    snapshot_.lockState = EntranceLockState::Locking;
    snapshot_.phase = EntrancePhase::Locking;
    snapshot_.actuatorSource = source;
    servoDeadlineMillis_ = nowMillis + ServoTransitionMs;
    setDisplay("authentication", "DANG KHOA CUA", "", "", "");
    pushEvent(EntranceEventType::LockChanged, reason, source);
    markChanged();
}

void EntranceController::beginUnlock(
    EntranceSource source,
    const char* reason,
    std::uint64_t nowMillis
) {
    clearPinBuffer();
    pinVerificationPending_ = false;
    doorOpenedSinceUnlock_ = false;
    unlockDeadlineMillis_ = 0;
    closedDeadlineMillis_ = 0;
    snapshot_.lockState = EntranceLockState::Unlocking;
    snapshot_.phase = EntrancePhase::Unlocking;
    snapshot_.actuatorSource = source;
    servoDeadlineMillis_ = nowMillis + ServoTransitionMs;
    setDisplay("authentication", "DANG MO KHOA", "", "", "");
    pushEvent(EntranceEventType::LockChanged, reason, source);
    markChanged();
}

void EntranceController::clearPinBuffer() {
    pinBuffer_.fill('\0');
    pinLength_ = 0;
}

bool EntranceController::keypadLocked(std::uint64_t nowMillis) {
    if (snapshot_.lockoutUntilMillis == 0) return false;
    if (nowMillis < snapshot_.lockoutUntilMillis) return true;
    snapshot_.lockoutUntilMillis = 0;
    snapshot_.attemptsRemaining = 3;
    if (snapshot_.phase == EntrancePhase::PinLockedOut) {
        snapshot_.phase = EntrancePhase::Idle;
        showIdle();
    }
    markChanged();
    return false;
}

bool EntranceController::safeToLock() const {
    return snapshot_.sensorState == EntranceSensorState::Ready
        && snapshot_.doorState == EntranceDoorState::Closed;
}

void EntranceController::showIdle() {
    if (customDisplayEnabled_) {
        snapshot_.lcdLines = customDisplay_;
        copyText(snapshot_.displaySource, "custom");
        return;
    }
    setDisplay(
        "firmware",
        "Xin chao!",
        "Cua dang khoa",
        "Nhan A de mo khoa",
        ""
    );
}

void EntranceController::showPinEntry(const char* heading) {
    std::array<char, 21> masked{};
    for (std::size_t index = 0; index < pinLength_ && index < 20; ++index) {
        masked[index] = '*';
    }
    setDisplay(
        "authentication",
        heading,
        masked.data(),
        "*: Xoa",
        "#: Xac nhan"
    );
}

void EntranceController::setDisplay(
    const char* source,
    const char* line1,
    const char* line2,
    const char* line3,
    const char* line4
) {
    copyText(snapshot_.displaySource, source);
    copyText(snapshot_.lcdLines[0], line1);
    copyText(snapshot_.lcdLines[1], line2);
    copyText(snapshot_.lcdLines[2], line3);
    copyText(snapshot_.lcdLines[3], line4);
}

void EntranceController::pushEvent(
    EntranceEventType type,
    const char* reason,
    EntranceSource source
) {
    const auto index = (eventHead_ + eventCount_) % events_.size();
    auto& event = events_[index];
    event = {};
    event.type = type;
    event.lockState = snapshot_.lockState;
    event.source = source;
    event.attemptsRemaining = snapshot_.attemptsRemaining;
    event.angleDegrees = snapshot_.doorAngleDegrees;
    event.deadlineMillis = snapshot_.lockoutUntilMillis;
    copyText(event.reason, reason);
    if (eventCount_ < events_.size()) {
        ++eventCount_;
    } else {
        eventHead_ = (eventHead_ + 1) % events_.size();
    }
}

void EntranceController::markChanged() {
    changed_ = true;
}

const char* EntranceController::lockStateName(EntranceLockState value) {
    switch (value) {
        case EntranceLockState::Locked: return "locked";
        case EntranceLockState::Unlocking: return "unlocking";
        case EntranceLockState::Unlocked: return "unlocked";
        case EntranceLockState::Locking: return "locking";
        case EntranceLockState::Fault: return "fault";
    }
    return "fault";
}

const char* EntranceController::doorStateName(EntranceDoorState value) {
    switch (value) {
        case EntranceDoorState::Closed: return "closed";
        case EntranceDoorState::Opening: return "opening";
        case EntranceDoorState::Open: return "open";
        case EntranceDoorState::Closing: return "closing";
        case EntranceDoorState::Unknown: return "unknown";
    }
    return "unknown";
}

const char* EntranceController::sensorStateName(EntranceSensorState value) {
    switch (value) {
        case EntranceSensorState::Calibrating: return "calibrating";
        case EntranceSensorState::Ready: return "ready";
        case EntranceSensorState::Fault: return "fault";
    }
    return "fault";
}

const char* EntranceController::phaseName(EntrancePhase value) {
    switch (value) {
        case EntrancePhase::Idle: return "idle";
        case EntrancePhase::PinEntry: return "pin_entry";
        case EntrancePhase::Unlocking: return "unlocking";
        case EntrancePhase::UnlockedWaitOpen: return "unlocked_wait_open";
        case EntrancePhase::DoorOpen: return "door_open";
        case EntrancePhase::ClosedWaitRelock: return "closed_wait_relock";
        case EntrancePhase::Locking: return "locking";
        case EntrancePhase::SensorFault: return "sensor_fault";
        case EntrancePhase::PinLockedOut: return "pin_locked_out";
    }
    return "sensor_fault";
}

const char* EntranceController::sourceName(EntranceSource value) {
    switch (value) {
        case EntranceSource::Keypad: return "keypad";
        case EntranceSource::Face: return "face";
        case EntranceSource::Remote: return "remote";
        case EntranceSource::Automatic: return "automatic";
        case EntranceSource::BootRecovery: return "boot_recovery";
        case EntranceSource::Unknown: return "unknown";
    }
    return "unknown";
}
