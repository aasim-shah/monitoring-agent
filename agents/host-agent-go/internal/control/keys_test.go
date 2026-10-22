package control

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateIdentityWritesPrivateFiles(t *testing.T) {
	dir := t.TempDir()
	id, err := GenerateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"agent.key", "x25519.key"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o, want 600", name, info.Mode().Perm())
		}
	}
	csrPem, err := id.CSR("pending")
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(csrPem))
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := csr.CheckSignature(); err != nil {
		t.Fatal(err)
	}
	pub, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		t.Fatalf("CSR key is not P-256: %T", csr.PublicKey)
	}
	if len(id.X25519PublicKeyBase64()) != 44 {
		t.Errorf("x25519 public key base64 length = %d, want 44", len(id.X25519PublicKeyBase64()))
	}

	loaded, err := LoadIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.X25519PublicKeyBase64() != id.X25519PublicKeyBase64() {
		t.Error("reloaded identity differs")
	}
}

func TestGenerateIdentityRefusesToOverwrite(t *testing.T) {
	dir := t.TempDir()
	if _, err := GenerateIdentity(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := GenerateIdentity(dir); err == nil {
		t.Fatal("second GenerateIdentity overwrote the existing key")
	}
}
