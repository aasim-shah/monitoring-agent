package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Release is one architecture's tarball and the binary inside it.
type Release struct {
	File   string
	SHA256 string
	Binary string
}

// Exporter is a Level 1 managed exporter (spec §8.9): version-pinned, checksum-verified, run as
// its own user and systemd unit, listening on 127.0.0.1 only.
type Exporter struct {
	Version string
	Port    int
	// TargetFlag precedes the local service address, for example --redis.addr=redis://.
	TargetFlag string
	Files      map[string]Release
}

// Exporters is the only set this helper installs; the checksums are compiled in.
var Exporters = map[string]Exporter{
	"redis_exporter": {
		Version: "v1.93.0", Port: 9121, TargetFlag: "--redis.addr=redis://",
		Files: map[string]Release{
			"amd64": {File: "redis_exporter-v1.93.0.linux-amd64.tar.gz", SHA256: "ed2e531fa68ca2b8604544e19d1088fe409d0592b9ab4f3093fba0783c764972", Binary: "redis_exporter-v1.93.0.linux-amd64/redis_exporter"},
			"arm64": {File: "redis_exporter-v1.93.0.linux-arm64.tar.gz", SHA256: "c41f29c98ed45964f0588c8644f74b06bae703f696244536691f09ecf7b081a1", Binary: "redis_exporter-v1.93.0.linux-arm64/redis_exporter"},
		},
	},
	"kafka_exporter": {
		Version: "v1.10.0", Port: 9308, TargetFlag: "--kafka.server=",
		Files: map[string]Release{
			"amd64": {File: "kafka_exporter-1.10.0.linux-amd64.tar.gz", SHA256: "246720dc4ecd8670801625423b7e44bbeb93115de07353cc6b4ea27e5bb7b87d", Binary: "kafka_exporter-1.10.0.linux-amd64/kafka_exporter"},
			"arm64": {File: "kafka_exporter-1.10.0.linux-arm64.tar.gz", SHA256: "47c3c19eec67a511fde2afcc714f9cdc382642ffcd72a1ac4c9535d8d433fee1", Binary: "kafka_exporter-1.10.0.linux-arm64/kafka_exporter"},
		},
	},
}

// Host is what installing changes on the machine besides files.
type Host interface {
	AddUser(name string) error
	DelUser(name string) error
	DaemonReload() error
	EnableNow(unit string) error
	DisableNow(unit string) error
}

// Installer installs and removes Level 1 exporters (M18.3).
type Installer struct {
	Catalog map[string]Exporter
	Host    Host
	Dir     string // /opt/pcp-exporters
	UnitDir string // /etc/systemd/system
	Client  *http.Client
	// Verify checks that the exporter answers on 127.0.0.1:port.
	Verify func(port int) error
}

// loopbackTarget is the local service the exporter reads: loopback only, host:port, nothing else.
var loopbackTarget = regexp.MustCompile(`^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$`)

const maxTarball = 50 << 20

func exporterUnit(name string) string { return "pcp-exporter-" + name + ".service" }

func userName(name string) string { return "pcp-exp-" + strings.TrimSuffix(name, "_exporter") }

// Install downloads, verifies, and starts one exporter; any failure removes everything it made.
func (in *Installer) Install(name, downloadURL, target string) (map[string]any, error) {
	e, ok := in.Catalog[name]
	if !ok {
		return nil, fmt.Errorf("exporter %s is not in this helper's catalog", name)
	}
	rel, ok := e.Files[runtime.GOARCH]
	if !ok {
		return nil, fmt.Errorf("exporter %s has no %s build", name, runtime.GOARCH)
	}
	if !loopbackTarget.MatchString(target) {
		return nil, fmt.Errorf("target %q must be a loopback host:port", target)
	}
	data, err := in.download(strings.TrimRight(downloadURL, "/") + "/exporters/" + rel.File)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != rel.SHA256 {
		return nil, fmt.Errorf("checksum mismatch for %s; nothing installed", rel.File)
	}
	binary, err := extract(data, rel.Binary)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(in.Dir, name)
	path := filepath.Join(dir, name)
	unit := filepath.Join(in.UnitDir, exporterUnit(name))
	user := userName(name)
	rollback := func() {
		_ = in.Host.DisableNow(exporterUnit(name))
		_ = os.Remove(unit)
		_ = os.RemoveAll(dir)
		_ = in.Host.DelUser(user)
		_ = in.Host.DaemonReload()
	}
	listen := fmt.Sprintf("127.0.0.1:%d", e.Port)
	steps := []func() error{
		func() error { return os.MkdirAll(dir, 0o755) },
		func() error { return os.MkdirAll(in.UnitDir, 0o755) },
		func() error { return os.WriteFile(path, binary, 0o755) },
		func() error { return in.Host.AddUser(user) },
		func() error {
			return os.WriteFile(unit, []byte(unitFile(name, user, path, listen, e.TargetFlag+target)), 0o644)
		},
		in.Host.DaemonReload,
		func() error { return in.Host.EnableNow(exporterUnit(name)) },
		func() error { return in.Verify(e.Port) },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			rollback()
			return nil, fmt.Errorf("install %s: %w (rolled back)", name, err)
		}
	}
	return map[string]any{"exporter": name, "version": e.Version, "unit": exporterUnit(name), "listen": listen}, nil
}

// Remove stops the exporter and deletes its unit, binary, and user.
func (in *Installer) Remove(name string) (map[string]any, error) {
	if _, ok := in.Catalog[name]; !ok {
		return nil, fmt.Errorf("exporter %s is not in this helper's catalog", name)
	}
	_ = in.Host.DisableNow(exporterUnit(name))
	var errs []error
	if err := os.Remove(filepath.Join(in.UnitDir, exporterUnit(name))); err != nil && !errors.Is(err, os.ErrNotExist) {
		errs = append(errs, err)
	}
	errs = append(errs, os.RemoveAll(filepath.Join(in.Dir, name)), in.Host.DelUser(userName(name)), in.Host.DaemonReload())
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return map[string]any{"exporter": name, "removed": true}, nil
}

func (in *Installer) download(url string) ([]byte, error) {
	res, err := in.Client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: status %d", url, res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxTarball+1))
	if err != nil || len(data) > maxTarball {
		return nil, fmt.Errorf("download %s: too large or unreadable", url)
	}
	return data, nil
}

func extract(data []byte, entry string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err != nil {
			return nil, fmt.Errorf("%s not found in the tarball", entry)
		}
		if h.Name == entry && h.Typeflag == tar.TypeReg {
			return io.ReadAll(io.LimitReader(tr, maxTarball))
		}
	}
}

func unitFile(name, user, path, listen, target string) string {
	return fmt.Sprintf(`# Managed by pcp-helper (Level 1 exporter, M18.3). Removed with the exporter.
[Unit]
Description=PCP managed %s
After=network-online.target

[Service]
User=%s
ExecStart=%s --web.listen-address=%s %s
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
`, name, user, path, listen, target)
}

// systemHost runs the real commands (root, from the helper's systemd unit).
type systemHost struct{}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (systemHost) AddUser(name string) error {
	if exec.Command("id", "-u", name).Run() == nil {
		return nil
	}
	return run("useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", name)
}

func (systemHost) DelUser(name string) error {
	if exec.Command("id", "-u", name).Run() != nil {
		return nil
	}
	return run("userdel", name)
}

func (systemHost) DaemonReload() error { return run("systemctl", "daemon-reload") }

func (systemHost) EnableNow(unit string) error { return run("systemctl", "enable", "--now", unit) }

func (systemHost) DisableNow(unit string) error { return run("systemctl", "disable", "--now", unit) }

// verifyLoopback waits up to 20 s for the exporter's /metrics on 127.0.0.1.
func verifyLoopback(port int) error {
	client := &http.Client{Timeout: 3 * time.Second}
	var last error
	for i := 0; i < 20; i++ {
		res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/metrics", port))
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
			err = fmt.Errorf("status %d", res.StatusCode)
		}
		last = err
		time.Sleep(time.Second)
	}
	return fmt.Errorf("exporter did not answer on 127.0.0.1:%d: %v", port, last)
}
