#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <array>
#include <cstdint>

enum class CredentialApplyResult : std::uint8_t {
    Applied,
    InvalidEnvelope,
    PrivateKeyUnavailable,
    DecryptionFailed,
    ContractMismatch,
    InvalidPin,
    StorageFailed,
};

class SecurePinStore {
public:
    bool begin();
    bool configured() const;
    bool verify(const char* candidate);
    bool replace(const char* sixDigitPin);

    CredentialApplyResult applyEncryptedEnvelope(
        JsonObjectConst envelope,
        const char* expectedJobId,
        const char* expectedInstanceId,
        const char* expectedCredentialName
    );

    static const char* resultReason(CredentialApplyResult result);

private:
    static constexpr std::size_t SaltBytes = 16;
    static constexpr std::size_t DigestBytes = 32;

    Preferences preferences_;
    bool ready_ = false;
    bool configured_ = false;

    bool loadVerifier(
        std::array<std::uint8_t, SaltBytes>& salt,
        std::array<std::uint8_t, DigestBytes>& digest
    );
};
