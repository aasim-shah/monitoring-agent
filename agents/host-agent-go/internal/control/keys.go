package control

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Identity is the host's private key material. It is generated on the host and only
// its CSR and public keys ever leave it (D11, WB-03 §10).
type Identity struct {
	Dir    string
	key    *ecdsa.PrivateKey
	x25519 *ecdh.PrivateKey
}

const (
	keyFile    = "agent.key"
	x25519File = "x25519.key"
	certFile   = "agent.crt"
	chainFile  = "chain.pem"
)

// GenerateIdentity creates agent.key (P-256) and x25519.key (pack credential sealing,
// D24) in dir with mode 0600. It refuses to replace existing keys.
func GenerateIdentity(dir string) (*Identity, error) {
	if _, err := os.Stat(filepath.Join(dir, keyFile)); err == nil {
		return nil, fmt.Errorf("%s already exists; refusing to overwrite an enrolled identity", filepath.Join(dir, keyFile))
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	xk, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	id := &Identity{Dir: dir, key: key, x25519: xk}
	if err := id.save(); err != nil {
		return nil, err
	}
	return id, nil
}

// LoadIdentity reads keys written by GenerateIdentity.
func LoadIdentity(dir string) (*Identity, error) {
	key, err := readKey(filepath.Join(dir, keyFile))
	if err != nil {
		return nil, err
	}
	ec, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("agent.key is not an ECDSA key")
	}
	xkey, err := readKey(filepath.Join(dir, x25519File))
	if err != nil {
		return nil, err
	}
	xk, ok := xkey.(*ecdh.PrivateKey)
	if !ok {
		return nil, errors.New("x25519.key is not an X25519 key")
	}
	return &Identity{Dir: dir, key: ec, x25519: xk}, nil
}

// Rekey replaces the signing key with a fresh one (certificate rotation). The caller
// writes the new certificate with SaveCertificate after the control plane signs the CSR.
func (id *Identity) Rekey() error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	id.key = key
	return writeKey(filepath.Join(id.Dir, keyFile), key)
}

// CSR returns a PEM certificate request for the signing key. The control plane sets the
// real subject (CN=<agentId>); commonName here is only a placeholder.
func (id *Identity) CSR(commonName string) (string, error) {
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: commonName},
	}, id.key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), nil
}

// X25519PublicKeyBase64 is the raw 32-byte public key, base64.
func (id *Identity) X25519PublicKeyBase64() string {
	return base64.StdEncoding.EncodeToString(id.x25519.PublicKey().Bytes())
}

// SaveCertificate writes the issued certificate and chain next to the keys (mode 0600).
func (id *Identity) SaveCertificate(certPem, chainPem string) error {
	if err := os.WriteFile(filepath.Join(id.Dir, certFile), []byte(certPem), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(id.Dir, chainFile), []byte(chainPem), 0o600)
}

func (id *Identity) save() error {
	if err := writeKey(filepath.Join(id.Dir, keyFile), id.key); err != nil {
		return err
	}
	return writeKey(filepath.Join(id.Dir, x25519File), id.x25519)
}

func writeKey(path string, key any) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func readKey(path string) (any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("%s: no PEM block", path)
	}
	return x509.ParsePKCS8PrivateKey(block.Bytes)
}

func marshalPKCS8(key any) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}
