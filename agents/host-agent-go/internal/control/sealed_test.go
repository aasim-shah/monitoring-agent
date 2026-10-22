package control

import (
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type sealedVector struct {
	RecipientPrivateKey string            `json:"recipientPrivateKey"`
	Sealed              string            `json:"sealed"`
	Plaintext           map[string]string `json:"plaintext"`
}

func loadSealedVector(t *testing.T) (sealedVector, *Identity) {
	t.Helper()
	raw, err := os.ReadFile("../../../../packages/agent-protocol/testdata/sealed-credentials.json")
	if err != nil {
		t.Fatal(err)
	}
	var v sealedVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	priv, _ := base64.StdEncoding.DecodeString(v.RecipientPrivateKey)
	key, err := ecdh.X25519().NewPrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return v, &Identity{x25519: key}
}

// The vector is sealed with WebCrypto, as the dashboard does (D24).
func TestOpenSealedVector(t *testing.T) {
	v, id := loadSealedVector(t)
	got, err := OpenSealed(v.Sealed, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(v.Plaintext) || got["username"] != v.Plaintext["username"] || got["password"] != v.Plaintext["password"] {
		t.Errorf("opened %v, want %v", got, v.Plaintext)
	}
}

func TestOpenSealedRejectsOtherKeyAndTampering(t *testing.T) {
	v, _ := loadSealedVector(t)
	other, err := GenerateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSealed(v.Sealed, other); err == nil {
		t.Error("opened with another agent's key")
	}
	_, id := loadSealedVector(t)
	raw, _ := base64.StdEncoding.DecodeString(v.Sealed)
	raw[len(raw)-1] ^= 1
	if _, err := OpenSealed(base64.StdEncoding.EncodeToString(raw), id); err == nil {
		t.Error("opened a tampered payload")
	}
	for _, bad := range []string{"", "not base64!", base64.StdEncoding.EncodeToString(make([]byte, 59)), strings.Repeat("A", 8000)} {
		if _, err := OpenSealed(bad, id); err == nil {
			t.Errorf("opened %q", bad)
		}
	}
}
