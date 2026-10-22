// Package control is the agent side of the control channel (spec §8, WB-03): identity
// keys, enrollment, heartbeats, signed tasks, and certificate rotation.
package control

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"unicode/utf16"
)

const maxSafeInteger = 1<<53 - 1

var integer = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)

// decodeNumbers decodes JSON keeping numbers as json.Number, so canonicalization sees
// them exactly as sent instead of as float64.
func decodeNumbers(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// canonicalJSON produces the signed byte form shared with @pcp/agent-protocol's
// canonicalJson: keys sorted by UTF-16 code unit at every depth, no whitespace, ASCII-only
// strings (every UTF-16 unit from U+007F up written as \uXXXX), and safe integers only.
func canonicalJSON(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := writeCanonical(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func writeCanonical(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		s := string(x)
		if !integer.MatchString(s) {
			return fmt.Errorf("canonical JSON allows only safe integers, got %s", s)
		}
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n > maxSafeInteger || n < -maxSafeInteger {
			return fmt.Errorf("canonical JSON allows only safe integers, got %s", s)
		}
		b.WriteString(strconv.FormatInt(n, 10))
	case string:
		writeString(b, x)
	case []any:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, item); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeString(b, k)
			b.WriteByte(':')
			if err := writeCanonical(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("canonical JSON cannot encode %T", v)
	}
	return nil
}

func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// writeString mirrors JSON.stringify's escapes, then escapes every unit >= 0x7f.
func writeString(b *bytes.Buffer, s string) {
	const hex = "0123456789abcdef"
	b.WriteByte('"')
	for _, u := range utf16.Encode([]rune(s)) {
		switch {
		case u == '"':
			b.WriteString(`\"`)
		case u == '\\':
			b.WriteString(`\\`)
		case u == '\b':
			b.WriteString(`\b`)
		case u == '\f':
			b.WriteString(`\f`)
		case u == '\n':
			b.WriteString(`\n`)
		case u == '\r':
			b.WriteString(`\r`)
		case u == '\t':
			b.WriteString(`\t`)
		case u < 0x20 || u >= 0x7f:
			b.WriteString(`\u`)
			b.WriteByte(hex[u>>12&0xf])
			b.WriteByte(hex[u>>8&0xf])
			b.WriteByte(hex[u>>4&0xf])
			b.WriteByte(hex[u&0xf])
		default:
			b.WriteByte(byte(u))
		}
	}
	b.WriteByte('"')
}

// verifyTask checks a raw task's Ed25519 signature over the canonical JSON of the task
// without its "signature" field (BR-03-07). It returns the canonical bytes for diagnostics.
func verifyTask(raw []byte, key ed25519.PublicKey) (bool, []byte, error) {
	v, err := decodeNumbers(raw)
	if err != nil {
		return false, nil, err
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return false, nil, fmt.Errorf("task is not an object")
	}
	sigText, _ := obj["signature"].(string)
	delete(obj, "signature")
	canonical, err := canonicalJSON(obj)
	if err != nil {
		return false, nil, err
	}
	sig, err := base64.StdEncoding.DecodeString(sigText)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return false, canonical, nil
	}
	return ed25519.Verify(key, canonical, sig), canonical, nil
}
