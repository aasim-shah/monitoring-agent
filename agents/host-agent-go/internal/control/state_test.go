package control

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateRoundTripIsPrivate(t *testing.T) {
	dir := t.TempDir()
	in := &State{AgentID: "a1", ControlURL: "https://agent.example.com", TaskSigningPublicKey: "k"}
	if err := SaveState(dir, in); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(dir, "state.json"))
	if info.Mode().Perm() != 0o600 {
		t.Errorf("state.json mode = %o", info.Mode().Perm())
	}
	out, err := LoadState(dir)
	if err != nil || *out != *in {
		t.Fatalf("LoadState = %+v, %v", out, err)
	}
	if _, err := LoadState(t.TempDir()); err == nil {
		t.Error("LoadState on an empty directory succeeded")
	}
}
