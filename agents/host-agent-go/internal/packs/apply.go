// Package packs applies the monitoring packs the control plane assigns to this agent
// (WB-11): it opens sealed credentials, rebuilds the collector configuration, has the
// collector validate it, and only then swaps it in and restarts the collector.
package packs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"pcp.local/hostagent/internal/collector"
	"pcp.local/hostagent/internal/control"
)

const (
	// ConfigFile is the running collector configuration (mode 0600: it holds credentials).
	ConfigFile = "collector.yaml"
	// StoreFile keeps the applied packs and their opened credentials across restarts,
	// since the control plane deletes the ciphertext once acknowledged (BR-11-03).
	StoreFile  = "packs.json"
	maxMessage = 2000
)

// Store is what the agent last applied.
type Store struct {
	PolicyVersion int                    `json:"policyVersion"`
	Packs         []collector.PackConfig `json:"packs"`
}

// LoadStore reads packs.json; a missing file is an empty store.
func LoadStore(dir string) (Store, error) {
	var st Store
	data, err := os.ReadFile(filepath.Join(dir, StoreFile))
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	return st, json.Unmarshal(data, &st)
}

func saveStore(dir string, st Store) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return writePrivate(filepath.Join(dir, StoreFile), data)
}

func writePrivate(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Applier turns an AgentConfig into a running collector configuration.
type Applier struct {
	Dir      string
	Base     collector.Input
	Open     func(sealed string) (map[string]string, error)
	Validate func(path string) error // pcp-otelcol validate --config <path>
	Restart  func()
}

// Apply never replaces the running configuration with one the collector rejects
// (Review Focus #2): packs that fail validation are reported failed and left out.
func (a *Applier) Apply(cfg control.AgentConfig) control.ConfigAck {
	ack := control.ConfigAck{PolicyVersion: cfg.PolicyVersion, Results: []control.PackResult{}}
	fail := func(id, msg string) {
		if len(msg) > maxMessage {
			msg = msg[:maxMessage]
		}
		ack.Results = append(ack.Results, control.PackResult{PackId: id, Status: "failed", Message: msg})
	}
	prev, err := LoadStore(a.Dir)
	if err != nil {
		prev = Store{}
	}
	stored := map[string]map[string]string{}
	for _, p := range prev.Packs {
		stored[p.ID] = p.Credentials
	}

	var candidates []collector.PackConfig
	for _, p := range cfg.Packs {
		creds := stored[p.PackId]
		if p.SealedCredentials != "" {
			opened, err := a.Open(p.SealedCredentials)
			if err != nil {
				fail(p.PackId, err.Error())
				continue
			}
			creds = opened
		}
		pc := collector.PackConfig{ID: p.PackId, Settings: p.Settings, Credentials: creds}
		if _, err := collector.Config(a.input(pc)); err != nil {
			fail(p.PackId, err.Error())
			continue
		}
		candidates = append(candidates, pc)
	}

	accepted := candidates
	if err := a.check(candidates...); err != nil {
		// Find the packs the collector rejects on their own; apply the rest.
		accepted = nil
		for _, pc := range candidates {
			if err := a.check(pc); err != nil {
				fail(pc.ID, err.Error())
			} else {
				accepted = append(accepted, pc)
			}
		}
		if err := a.check(accepted...); err != nil {
			for _, pc := range accepted {
				fail(pc.ID, err.Error())
			}
			return ack
		}
	}

	data, err := collector.Config(a.input(accepted...))
	if err == nil {
		err = writePrivate(filepath.Join(a.Dir, ConfigFile), data)
	}
	if err == nil {
		err = saveStore(a.Dir, Store{PolicyVersion: cfg.PolicyVersion, Packs: accepted})
	}
	if err != nil {
		for _, pc := range accepted {
			fail(pc.ID, fmt.Sprintf("writing the collector configuration: %v", err))
		}
		return ack
	}
	a.Restart()
	for _, pc := range accepted {
		ack.Results = append(ack.Results, control.PackResult{PackId: pc.ID, Status: "applied"})
	}
	return ack
}

func (a *Applier) input(packs ...collector.PackConfig) collector.Input {
	in := a.Base
	in.Packs = packs
	return in
}

// check writes a candidate configuration next to the running one and validates it.
func (a *Applier) check(packs ...collector.PackConfig) error {
	data, err := collector.Config(a.input(packs...))
	if err != nil {
		return err
	}
	path := filepath.Join(a.Dir, "collector.candidate.yaml")
	defer os.Remove(path)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return a.Validate(path)
}

// Validator runs `pcp-otelcol validate`; the error carries the collector's own message.
func Validator(bin string) func(path string) error {
	return func(path string) error {
		out, err := exec.Command(bin, "validate", "--config", path).CombinedOutput()
		if err == nil {
			return nil
		}
		msg := strings.TrimSpace(string(out))
		if len(msg) > 1500 {
			msg = msg[len(msg)-1500:]
		}
		if msg == "" {
			msg = err.Error()
		}
		return errors.New(msg)
	}
}
