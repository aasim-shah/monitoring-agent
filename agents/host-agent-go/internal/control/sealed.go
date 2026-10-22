package control

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
)

// Pack credentials are sealed in the browser to the agent's X25519 key (D24):
// ECIES with X25519, HKDF-SHA256 (salt = ephemeral public || recipient public), and
// AES-256-GCM. The payload is ephemeral public (32) || nonce (12) || ciphertext+tag.
const (
	sealedInfo     = "pcp-pack-credentials-v1"
	maxSealedBytes = 4096
	minSealedBytes = 32 + 12 + 16
)

var errSealed = errors.New("sealed credentials cannot be opened with this agent's key")

// OpenSealed returns the credential fields sealed to id's X25519 key.
func OpenSealed(sealedB64 string, id *Identity) (map[string]string, error) {
	if len(sealedB64) > maxSealedBytes {
		return nil, errSealed
	}
	raw, err := base64.StdEncoding.DecodeString(sealedB64)
	if err != nil || len(raw) < minSealedBytes {
		return nil, errSealed
	}
	ephPub, nonce, ct := raw[:32], raw[32:44], raw[44:]
	eph, err := ecdh.X25519().NewPublicKey(ephPub)
	if err != nil {
		return nil, errSealed
	}
	shared, err := id.x25519.ECDH(eph) // rejects low-order points (all-zero secret)
	if err != nil {
		return nil, errSealed
	}
	salt := append(append([]byte{}, ephPub...), id.x25519.PublicKey().Bytes()...)
	block, err := aes.NewCipher(hkdfSHA256(shared, salt, []byte(sealedInfo), 32))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, errSealed
	}
	var fields map[string]string
	if err := json.Unmarshal(plain, &fields); err != nil {
		return nil, errors.New("sealed credentials are not a JSON object of strings")
	}
	return fields, nil
}

// hkdfSHA256 is RFC 5869 extract-and-expand (crypto/hkdf needs Go 1.24).
func hkdfSHA256(ikm, salt, info []byte, length int) []byte {
	ext := hmac.New(sha256.New, salt)
	ext.Write(ikm)
	prk := ext.Sum(nil)
	var out, prev []byte
	for i := byte(1); len(out) < length; i++ {
		exp := hmac.New(sha256.New, prk)
		exp.Write(prev)
		exp.Write(info)
		exp.Write([]byte{i})
		prev = exp.Sum(nil)
		out = append(out, prev...)
	}
	return out[:length]
}
