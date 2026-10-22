package control

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func TestCanonicalJSONMatchesTypeScript(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{`{"b":1,"a":{"d":[3,{"z":true,"y":null}],"c":"x"}}`, `{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}`},
		{"{\"b\":1,\"a\":\"\\u00e9\"}", "{\"a\":\"\\u00e9\",\"b\":1}"},
		{"\"<&>\\u2028\\u007f\\ud83d\\ude00\"", "\"<&>\\u2028\\u007f\\ud83d\\ude00\""},
		{`"line\nbreak \"q\" \\"`, `"line\nbreak \"q\" \\"`},
		{`{"n":-42}`, `{"n":-42}`},
	}
	for _, c := range cases {
		v, err := decodeNumbers([]byte(c.in))
		if err != nil {
			t.Fatalf("decode %s: %v", c.in, err)
		}
		got, err := canonicalJSON(v)
		if err != nil {
			t.Fatalf("canonical %s: %v", c.in, err)
		}
		if string(got) != c.want {
			t.Errorf("canonicalJSON(%s) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestCanonicalJSONRejectsNonIntegers(t *testing.T) {
	for _, in := range []string{`{"n":1.5}`, `{"n":1e3}`, `{"n":1152921504606846976}`} {
		v, err := decodeNumbers([]byte(in))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := canonicalJSON(v); err == nil {
			t.Errorf("canonicalJSON(%s) accepted a non-safe-integer", in)
		}
	}
}

// Review Focus #4: the signature made by the TypeScript signer verifies here.
func TestSharedSignatureVector(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/agent-protocol/testdata/task-signature.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		PublicKey string          `json:"publicKey"`
		Task      json.RawMessage `json:"task"`
		Canonical string          `json:"canonical"`
		Signature string          `json:"signature"`
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	key, _ := base64.StdEncoding.DecodeString(vector.PublicKey)
	ok, canonical, err := verifyTask(vector.Task, ed25519.PublicKey(key))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(canonical, []byte(vector.Canonical)) {
		t.Fatalf("canonical mismatch:\n got %s\nwant %s", canonical, vector.Canonical)
	}
	if !ok {
		t.Fatal("shared vector signature did not verify")
	}
	tampered := bytes.Replace(vector.Task, []byte("agent_info"), []byte("agent_infp"), 1)
	if ok, _, _ := verifyTask(tampered, ed25519.PublicKey(key)); ok {
		t.Fatal("tampered task verified")
	}
}
