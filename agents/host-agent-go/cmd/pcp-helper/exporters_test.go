package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

type fakeHost struct {
	users     []string
	enabled   []string
	disabled  []string
	reloads   int
	failStart bool
}

func (f *fakeHost) AddUser(name string) error {
	f.users = append(f.users, name)
	return nil
}

func (f *fakeHost) DelUser(name string) error {
	f.users = slices.DeleteFunc(f.users, func(u string) bool { return u == name })
	return nil
}

func (f *fakeHost) DaemonReload() error {
	f.reloads++
	return nil
}

func (f *fakeHost) EnableNow(unit string) error {
	f.enabled = append(f.enabled, unit)
	if f.failStart {
		return errors.New("unit failed to start")
	}
	return nil
}

func (f *fakeHost) DisableNow(unit string) error {
	f.disabled = append(f.disabled, unit)
	return nil
}

// tarball builds an exporter release with the binary at its usual path.
func tarball(t *testing.T, entry string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte("#!/bin/sh\necho exporter\n")
	_ = tw.WriteHeader(&tar.Header{Name: entry, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(body)
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

type installerSetup struct {
	in   *Installer
	host *fakeHost
	dir  string
	srv  *httptest.Server
}

func newInstaller(t *testing.T, tamper bool) installerSetup {
	t.Helper()
	dir := t.TempDir()
	file := "redis_exporter-v1.93.0.linux-" + runtime.GOARCH + ".tar.gz"
	data := tarball(t, "redis_exporter-v1.93.0.linux-"+runtime.GOARCH+"/redis_exporter")
	sum := sha256.Sum256(data)
	if tamper {
		data = append(data, 'x')
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/downloads/exporters/"+file {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(srv.Close)
	catalog := map[string]Exporter{"redis_exporter": {
		Version: "v1.93.0", Port: 9121, TargetFlag: "--redis.addr=redis://",
		Files: map[string]Release{runtime.GOARCH: {File: file, SHA256: hex.EncodeToString(sum[:]), Binary: "redis_exporter-v1.93.0.linux-" + runtime.GOARCH + "/redis_exporter"}},
	}}
	host := &fakeHost{}
	in := &Installer{
		Catalog: catalog, Host: host, Dir: filepath.Join(dir, "opt"), UnitDir: filepath.Join(dir, "units"),
		Client: srv.Client(), Verify: func(port int) error { return nil },
	}
	return installerSetup{in: in, host: host, dir: dir, srv: srv}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// UC-11 Level 1: a version-pinned exporter as its own user and unit, bound to loopback.
func TestInstallRunsTheExporterOnLoopbackAsItsOwnUser(t *testing.T) {
	s := newInstaller(t, false)
	res, err := s.in.Install("redis_exporter", s.srv.URL+"/downloads", "127.0.0.1:6379")
	if err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile(filepath.Join(s.dir, "units", "pcp-exporter-redis_exporter.service"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"User=pcp-exp-redis",
		"ExecStart=" + filepath.Join(s.dir, "opt", "redis_exporter", "redis_exporter") + " --web.listen-address=127.0.0.1:9121 --redis.addr=redis://127.0.0.1:6379",
		"NoNewPrivileges=yes",
		"ProtectSystem=strict",
	} {
		if !strings.Contains(string(unit), want) {
			t.Errorf("unit lacks %q:\n%s", want, unit)
		}
	}
	if !exists(filepath.Join(s.dir, "opt", "redis_exporter", "redis_exporter")) || !slices.Contains(s.host.users, "pcp-exp-redis") {
		t.Error("binary or user missing")
	}
	if res["listen"] != "127.0.0.1:9121" || res["version"] != "v1.93.0" {
		t.Errorf("result = %v", res)
	}
}

// BR-05-07 for exporters: a tampered download installs nothing.
func TestInstallRefusesAChecksumMismatchAndLeavesNothing(t *testing.T) {
	s := newInstaller(t, true)
	if _, err := s.in.Install("redis_exporter", s.srv.URL+"/downloads", "127.0.0.1:6379"); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("err = %v", err)
	}
	if exists(filepath.Join(s.dir, "opt", "redis_exporter")) || exists(filepath.Join(s.dir, "units", "pcp-exporter-redis_exporter.service")) || len(s.host.users) != 0 {
		t.Error("left something behind")
	}
}

// Review Focus #5: an exporter that does not start is rolled back completely.
func TestFailedInstallRollsBackAndRemoveCleansUp(t *testing.T) {
	s := newInstaller(t, false)
	s.host.failStart = true
	if _, err := s.in.Install("redis_exporter", s.srv.URL+"/downloads", "127.0.0.1:6379"); err == nil {
		t.Fatal("install of a failing unit succeeded")
	}
	if exists(filepath.Join(s.dir, "opt", "redis_exporter")) || exists(filepath.Join(s.dir, "units", "pcp-exporter-redis_exporter.service")) || len(s.host.users) != 0 {
		t.Error("rollback left something behind")
	}
	s.host.failStart = false
	if _, err := s.in.Install("redis_exporter", s.srv.URL+"/downloads", "127.0.0.1:6379"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.in.Remove("redis_exporter"); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(s.dir, "opt", "redis_exporter")) || exists(filepath.Join(s.dir, "units", "pcp-exporter-redis_exporter.service")) || len(s.host.users) != 0 {
		t.Error("remove left something behind")
	}
}

func TestInstallRefusesUnknownExportersAndRemoteTargets(t *testing.T) {
	s := newInstaller(t, false)
	for _, c := range [][2]string{{"node_exporter", "127.0.0.1:9100"}, {"redis_exporter", "10.0.0.5:6379"}, {"redis_exporter", "127.0.0.1:6379 --evil"}} {
		if _, err := s.in.Install(c[0], s.srv.URL+"/downloads", c[1]); err == nil {
			t.Errorf("%v accepted", c)
		}
	}
}

// The builtin catalog pins both architectures of both exporters.
func TestBuiltinCatalogIsPinned(t *testing.T) {
	for name, e := range Exporters {
		for _, arch := range []string{"amd64", "arm64"} {
			r, ok := e.Files[arch]
			if !ok || len(r.SHA256) != 64 || !strings.Contains(r.File, strings.TrimPrefix(e.Version, "v")) || !strings.HasSuffix(r.Binary, "/"+name) {
				t.Errorf("%s %s: %+v", name, arch, r)
			}
		}
	}
}

func exporterTask(id, capability string, payload map[string]any) map[string]any {
	t := restartTask(id, "x.service", now.Add(10*time.Minute))
	t["resourceScope"] = map[string]any{"exporter": payload["exporter"]}
	p := map[string]any{"capability": capability}
	for k, v := range payload {
		p[k] = v
	}
	t["payload"] = p
	return t
}

// The customer opts in to the pack installer in helper.yaml (--enable-pack-installer); off by default.
func TestPackInstallNeedsTheHostOptIn(t *testing.T) {
	s := newSetup(t, allowAPI)
	inst := newInstaller(t, false)
	s.helper.Installer = inst.in
	task := exporterTask("e1", "pack_install", map[string]any{"exporter": "redis_exporter", "downloadUrl": inst.srv.URL + "/downloads", "target": "127.0.0.1:6379"})
	if r := s.helper.Handle(signed(t, s.priv, task)); r.Status != "failed" || !strings.Contains(r.Error, "not enabled") {
		t.Fatalf("without opt-in: %+v", r)
	}
	on := newSetup(t, "capabilities:\n  pack_install:\n    enabled: true\n")
	on.helper.Installer = inst.in
	r := on.helper.Handle(signed(t, on.priv, exporterTask("e2", "pack_install", map[string]any{"exporter": "redis_exporter", "downloadUrl": inst.srv.URL + "/downloads", "target": "127.0.0.1:6379"})))
	if r.Status != "succeeded" || r.Result["listen"] != "127.0.0.1:9121" {
		t.Fatalf("install: %+v", r)
	}
	r = on.helper.Handle(signed(t, on.priv, exporterTask("e3", "pack_remove", map[string]any{"exporter": "redis_exporter"})))
	if r.Status != "succeeded" || r.Result["removed"] != true {
		t.Fatalf("remove: %+v", r)
	}
	if r := on.helper.Handle(signed(t, on.priv, exporterTask("e3", "pack_remove", map[string]any{"exporter": "redis_exporter"}))); r.Error != "task was already used" {
		t.Fatalf("replay: %+v", r)
	}
}
