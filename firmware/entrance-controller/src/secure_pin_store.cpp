#include "secure_pin_store.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <vector>

#include <esp_system.h>
#include <mbedtls/base64.h>
#include <mbedtls/gcm.h>
#include <mbedtls/pk.h>
#include <mbedtls/rsa.h>
#include <mbedtls/sha256.h>
#include <mbedtls/version.h>

namespace {

bool isSixDigitPin(const char* value) {
    if (!value || std::strlen(value) != 6) return false;
    for (std::size_t index = 0; index < 6; ++index) {
        if (value[index] < '0' || value[index] > '9') return false;
    }
    return true;
}

void wipe(void* value, std::size_t length) {
    auto* bytes = static_cast<volatile std::uint8_t*>(value);
    while (length-- > 0) *bytes++ = 0;
}

bool sha256(
    const std::uint8_t* salt,
    std::size_t saltLength,
    const char* pin,
    std::uint8_t* output
) {
    mbedtls_sha256_context context;
    mbedtls_sha256_init(&context);
    bool success = mbedtls_sha256_starts_ret(&context, 0) == 0
        && mbedtls_sha256_update_ret(&context, salt, saltLength) == 0
        && mbedtls_sha256_update_ret(
            &context,
            reinterpret_cast<const std::uint8_t*>(pin),
            std::strlen(pin)
        ) == 0
        && mbedtls_sha256_finish_ret(&context, output) == 0;
    mbedtls_sha256_free(&context);
    return success;
}

bool decodeBase64(const char* encoded, std::vector<std::uint8_t>& output) {
    if (!encoded || encoded[0] == '\0') return false;
    std::size_t required = 0;
    const auto* input = reinterpret_cast<const std::uint8_t*>(encoded);
    const auto length = std::strlen(encoded);
    const int sizing = mbedtls_base64_decode(nullptr, 0, &required, input, length);
    if (sizing != MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL || required == 0) return false;
    output.assign(required, 0);
    std::size_t written = 0;
    if (mbedtls_base64_decode(output.data(), output.size(), &written, input, length) != 0) {
        output.clear();
        return false;
    }
    output.resize(written);
    return true;
}

int hardwareRandom(void*, unsigned char* output, std::size_t length) {
    esp_fill_random(output, length);
    return 0;
}

String loadFactoryPrivateKey() {
    Preferences factory;
    if (!factory.begin("factory", true)) return "";
    const String privateKey = factory.getString("credentialKey", "");
    factory.end();
    return privateKey;
}

bool rsaDecryptKey(
    const String& privateKeyPem,
    const std::vector<std::uint8_t>& encrypted,
    std::array<std::uint8_t, 32>& output
) {
    mbedtls_pk_context key;
    mbedtls_pk_init(&key);
#if MBEDTLS_VERSION_MAJOR >= 3
    const int parsed = mbedtls_pk_parse_key(
        &key,
        reinterpret_cast<const std::uint8_t*>(privateKeyPem.c_str()),
        privateKeyPem.length() + 1,
        nullptr,
        0,
        hardwareRandom,
        nullptr
    );
#else
    const int parsed = mbedtls_pk_parse_key(
        &key,
        reinterpret_cast<const std::uint8_t*>(privateKeyPem.c_str()),
        privateKeyPem.length() + 1,
        nullptr,
        0
    );
#endif
    if (parsed != 0 || !mbedtls_pk_can_do(&key, MBEDTLS_PK_RSA)) {
        mbedtls_pk_free(&key);
        return false;
    }
    auto* rsa = mbedtls_pk_rsa(key);
    mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, MBEDTLS_MD_SHA256);
    std::size_t written = 0;
    std::array<std::uint8_t, 256> plaintext{};
    const int result = mbedtls_pk_decrypt(
        &key,
        encrypted.data(),
        encrypted.size(),
        plaintext.data(),
        &written,
        plaintext.size(),
        hardwareRandom,
        nullptr
    );
    const bool valid = result == 0 && written == output.size();
    if (valid) std::copy_n(plaintext.begin(), output.size(), output.begin());
    wipe(plaintext.data(), plaintext.size());
    mbedtls_pk_free(&key);
    return valid;
}

bool aesGcmDecrypt(
    const std::array<std::uint8_t, 32>& key,
    const std::vector<std::uint8_t>& iv,
    const std::vector<std::uint8_t>& ciphertext,
    const std::vector<std::uint8_t>& tag,
    std::vector<std::uint8_t>& plaintext
) {
    if (iv.size() != 12 || tag.size() != 16 || ciphertext.empty()) return false;
    plaintext.assign(ciphertext.size() + 1, 0);
    mbedtls_gcm_context context;
    mbedtls_gcm_init(&context);
    const bool success = mbedtls_gcm_setkey(
        &context,
        MBEDTLS_CIPHER_ID_AES,
        key.data(),
        256
    ) == 0 && mbedtls_gcm_auth_decrypt(
        &context,
        ciphertext.size(),
        iv.data(),
        iv.size(),
        nullptr,
        0,
        tag.data(),
        tag.size(),
        ciphertext.data(),
        plaintext.data()
    ) == 0;
    mbedtls_gcm_free(&context);
    if (!success) {
        wipe(plaintext.data(), plaintext.size());
        plaintext.clear();
    }
    return success;
}

}  // namespace

bool SecurePinStore::begin() {
    ready_ = preferences_.begin("entrance-sec", false);
    configured_ = ready_
        && preferences_.getBytesLength("pinSalt") == SaltBytes
        && preferences_.getBytesLength("pinDigest") == DigestBytes;
    return ready_;
}

bool SecurePinStore::configured() const {
    return configured_;
}

bool SecurePinStore::loadVerifier(
    std::array<std::uint8_t, SaltBytes>& salt,
    std::array<std::uint8_t, DigestBytes>& digest
) {
    if (!ready_ || !configured_) return false;
    return preferences_.getBytes("pinSalt", salt.data(), salt.size()) == salt.size()
        && preferences_.getBytes("pinDigest", digest.data(), digest.size()) == digest.size();
}

bool SecurePinStore::verify(const char* candidate) {
    if (!isSixDigitPin(candidate)) return false;
    std::array<std::uint8_t, SaltBytes> salt{};
    std::array<std::uint8_t, DigestBytes> expected{};
    std::array<std::uint8_t, DigestBytes> actual{};
    if (!loadVerifier(salt, expected) || !sha256(salt.data(), salt.size(), candidate, actual.data())) {
        wipe(salt.data(), salt.size());
        wipe(expected.data(), expected.size());
        wipe(actual.data(), actual.size());
        return false;
    }
    std::uint8_t difference = 0;
    for (std::size_t index = 0; index < actual.size(); ++index) {
        difference |= static_cast<std::uint8_t>(actual[index] ^ expected[index]);
    }
    wipe(salt.data(), salt.size());
    wipe(expected.data(), expected.size());
    wipe(actual.data(), actual.size());
    return difference == 0;
}

bool SecurePinStore::replace(const char* sixDigitPin) {
    if (!ready_ || !isSixDigitPin(sixDigitPin)) return false;
    std::array<std::uint8_t, SaltBytes> salt{};
    std::array<std::uint8_t, DigestBytes> digest{};
    esp_fill_random(salt.data(), salt.size());
    if (!sha256(salt.data(), salt.size(), sixDigitPin, digest.data())) return false;
    const bool stored = preferences_.putBytes("pinSalt", salt.data(), salt.size()) == salt.size()
        && preferences_.putBytes("pinDigest", digest.data(), digest.size()) == digest.size();
    wipe(salt.data(), salt.size());
    wipe(digest.data(), digest.size());
    configured_ = stored;
    return stored;
}

CredentialApplyResult SecurePinStore::applyEncryptedEnvelope(
    JsonObjectConst envelope,
    const char* expectedJobId,
    const char* expectedInstanceId,
    const char* expectedCredentialName
) {
    if (
        envelope.isNull()
        || String(envelope["algorithm"] | "") != "RSA-OAEP-256+A256GCM"
    ) {
        return CredentialApplyResult::InvalidEnvelope;
    }
    String privateKey = loadFactoryPrivateKey();
    if (privateKey.isEmpty()) return CredentialApplyResult::PrivateKeyUnavailable;

    std::vector<std::uint8_t> encryptedKey;
    std::vector<std::uint8_t> iv;
    std::vector<std::uint8_t> ciphertext;
    std::vector<std::uint8_t> tag;
    if (
        !decodeBase64(envelope["encrypted_key_base64"], encryptedKey)
        || !decodeBase64(envelope["iv_base64"], iv)
        || !decodeBase64(envelope["ciphertext_base64"], ciphertext)
        || !decodeBase64(envelope["auth_tag_base64"], tag)
    ) {
        return CredentialApplyResult::InvalidEnvelope;
    }

    std::array<std::uint8_t, 32> envelopeKey{};
    std::vector<std::uint8_t> plaintext;
    const bool decrypted = rsaDecryptKey(privateKey, encryptedKey, envelopeKey)
        && aesGcmDecrypt(envelopeKey, iv, ciphertext, tag, plaintext);
    for (std::size_t index = 0; index < privateKey.length(); ++index) {
        privateKey[index] = '\0';
    }
    wipe(envelopeKey.data(), envelopeKey.size());
    if (!decrypted) return CredentialApplyResult::DecryptionFailed;

    JsonDocument materialDocument;
    const auto parseError = deserializeJson(
        materialDocument,
        reinterpret_cast<char*>(plaintext.data()),
        plaintext.size() - 1
    );
    if (parseError) {
        wipe(plaintext.data(), plaintext.size());
        return CredentialApplyResult::DecryptionFailed;
    }
    JsonObjectConst material = materialDocument.as<JsonObjectConst>();
    const bool matchesContract = String(material["job_id"] | "") == expectedJobId
        && String(material["instance_id"] | "") == expectedInstanceId
        && String(material["credential_name"] | "") == expectedCredentialName;
    String pin = material["material"] | "";
    materialDocument.clear();
    wipe(plaintext.data(), plaintext.size());
    plaintext.clear();
    CredentialApplyResult result = CredentialApplyResult::Applied;
    if (!matchesContract) result = CredentialApplyResult::ContractMismatch;
    else if (!isSixDigitPin(pin.c_str())) result = CredentialApplyResult::InvalidPin;
    else if (!replace(pin.c_str())) result = CredentialApplyResult::StorageFailed;
    for (std::size_t index = 0; index < pin.length(); ++index) pin[index] = '\0';
    return result;
}

const char* SecurePinStore::resultReason(CredentialApplyResult result) {
    switch (result) {
        case CredentialApplyResult::Applied: return "";
        case CredentialApplyResult::InvalidEnvelope: return "INVALID_CREDENTIAL_ENVELOPE";
        case CredentialApplyResult::PrivateKeyUnavailable: return "CREDENTIAL_PRIVATE_KEY_UNAVAILABLE";
        case CredentialApplyResult::DecryptionFailed: return "CREDENTIAL_DECRYPTION_FAILED";
        case CredentialApplyResult::ContractMismatch: return "CREDENTIAL_CONTRACT_MISMATCH";
        case CredentialApplyResult::InvalidPin: return "INVALID_SIX_DIGIT_PIN";
        case CredentialApplyResult::StorageFailed: return "CREDENTIAL_STORAGE_FAILED";
    }
    return "DEVICE_CREDENTIAL_REJECTED";
}
