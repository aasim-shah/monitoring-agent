package discovery

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

func tcpLine(i int, hexAddr string, port int, state string) string {
	return fmt.Sprintf("  %d: %s:%04X 00000000:0000 %s 00000000:00000000 00:00000000 00000000   999        0 %d 1 0000000000000000 100 0 0 10 0\n", i, hexAddr, port, state, 1000+i)
}

func proc(fsys fstest.MapFS, pid int, comm string, cmdline ...string) {
	fsys[fmt.Sprintf("%d/comm", pid)] = &fstest.MapFile{Data: []byte(comm + "\n")}
	fsys[fmt.Sprintf("%d/cmdline", pid)] = &fstest.MapFile{Data: []byte(strings.Join(cmdline, "\x00") + "\x00")}
	fsys[fmt.Sprintf("%d/environ", pid)] = &fstest.MapFile{Data: []byte("SECRET=do-not-read\x00")}
}

func fixture() fstest.MapFS {
	fsys := fstest.MapFS{
		"net/tcp": &fstest.MapFile{Data: []byte(tcpHeader +
			tcpLine(0, "0100007F", 6379, "0A") + // redis on 127.0.0.1
			tcpLine(1, "00000000", 5432, "0A") + // postgres on 0.0.0.0 (exposed)
			tcpLine(2, "00000000", 22, "0A") + // sshd
			tcpLine(3, "0100007F", 9092, "0A") + // kafka on loopback
			tcpLine(4, "0100007F", 40000, "01"))}, // established, ignored
		"net/tcp6": &fstest.MapFile{Data: []byte(tcpHeader +
			tcpLine(0, "00000000000000000000000000000000", 3000, "0A") + // node on [::]
			tcpLine(1, "00000000000000000000000001000000", 27017, "0A"))}, // mongod on [::1]
		"self":       &fstest.MapFile{Mode: fs.ModeSymlink, Data: []byte("1")},
		"meminfo":    &fstest.MapFile{Data: []byte("MemTotal: 1 kB\n")},
		"abc/status": &fstest.MapFile{Data: []byte("x")},
	}
	proc(fsys, 101, "redis-server", "/usr/bin/redis-server 127.0.0.1:6379")
	proc(fsys, 202, "postgres", "/usr/lib/postgresql/16/bin/postgres", "-D", "/var/lib/postgresql/16/main")
	proc(fsys, 203, "postgres", "postgres: checkpointer")
	proc(fsys, 303, "java", "java", "-Xmx1G", "-cp", "/opt/kafka/libs/*", "kafka.Kafka", "/opt/kafka/config/server.properties")
	proc(fsys, 404, "node", "node", "/srv/api/dist/main.js")
	proc(fsys, 405, "PM2 v5.3.0: God", "PM2 v5.3.0: God Daemon (/root/.pm2)")
	proc(fsys, 406, "node", "node", "/srv/web/server.js")
	proc(fsys, 505, "mongod", "/usr/bin/mongod", "--config", "/etc/mongod.conf")
	proc(fsys, 606, "sshd", "sshd: /usr/sbin/sshd -D")
	return fsys
}

// noEnviron fails the test if anything opens /proc/<pid>/environ (Review Focus #3).
type noEnviron struct {
	fs.FS
	t *testing.T
}

func (n noEnviron) Open(name string) (fs.File, error) {
	if strings.HasSuffix(name, "/environ") {
		n.t.Fatalf("discovery opened %s", name)
	}
	return n.FS.Open(name)
}

func find(inv Inventory, pack string) *Service {
	for i := range inv.Services {
		if inv.Services[i].Pack == pack {
			return &inv.Services[i]
		}
	}
	return nil
}

func TestScanFindsServicesAndExposure(t *testing.T) {
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	inv, err := Scan(noEnviron{fixture(), t}, now)
	if err != nil {
		t.Fatal(err)
	}
	if inv.CollectedAt != "2026-10-22T12:00:00Z" {
		t.Errorf("collectedAt = %s", inv.CollectedAt)
	}
	redis := find(inv, "redis")
	if redis == nil || redis.ProcessCount != 1 || len(redis.Ports) != 1 || redis.Ports[0].Address != "127.0.0.1" || redis.Ports[0].Port != 6379 {
		t.Errorf("redis = %+v", redis)
	}
	pg := find(inv, "postgresql")
	if pg == nil || pg.ProcessCount != 2 || pg.Ports[0].Address != "0.0.0.0" {
		t.Errorf("postgresql = %+v", pg)
	}
	if k := find(inv, "kafka"); k == nil || k.Ports[0].Port != 9092 {
		t.Errorf("kafka (by command line) = %+v", k)
	}
	if n := find(inv, "nodejs"); n == nil || n.ProcessCount != 3 {
		t.Errorf("nodejs = %+v", n)
	}
	if m := find(inv, "mongodb"); m == nil || m.Ports[0].Address != "::1" {
		t.Errorf("mongodb = %+v", m)
	}
	if find(inv, "mysql") != nil || find(inv, "nginx") != nil {
		t.Errorf("reported services that are not running: %+v", inv.Services)
	}
	if len(inv.Warnings) != 1 || inv.Warnings[0].Pack != "postgresql" || inv.Warnings[0].Address != "0.0.0.0" || inv.Warnings[0].Port != 5432 {
		t.Errorf("warnings = %+v (want only postgresql exposed)", inv.Warnings)
	}
	if len(inv.Listeners) != 6 {
		t.Errorf("listeners = %d, want 6 (LISTEN only)", len(inv.Listeners))
	}
}

func TestScanSkipsUnreadableAndMalformedEntries(t *testing.T) {
	fsys := fixture()
	fsys["net/tcp"].Data = append(fsys["net/tcp"].Data, []byte("garbage line\n   9: ZZZZ:XYZ\n")...)
	fsys["777/cmdline"] = &fstest.MapFile{Data: []byte("x\x00")}
	inv, err := Scan(errorsOn{fsys, "777/comm"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if find(inv, "redis") == nil {
		t.Fatal("one unreadable process stopped the scan")
	}
}

func TestScanCapsOutput(t *testing.T) {
	fsys := fstest.MapFS{"net/tcp": &fstest.MapFile{Data: []byte(tcpHeader)}}
	var lines strings.Builder
	lines.WriteString(tcpHeader)
	for i := 0; i < 800; i++ {
		lines.WriteString(tcpLine(i, "0100007F", 20000+i, "0A"))
	}
	fsys["net/tcp"].Data = []byte(lines.String())
	for pid := 1; pid <= 3000; pid++ {
		proc(fsys, pid, "node", "node", "app.js")
	}
	inv, err := Scan(fsys, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Listeners) > maxListeners {
		t.Errorf("listeners = %d, cap %d", len(inv.Listeners), maxListeners)
	}
	if n := find(inv, "nodejs"); n == nil || n.ProcessCount > maxProcesses {
		t.Errorf("nodejs = %+v, cap %d", n, maxProcesses)
	}
}

type errorsOn struct {
	fstest.MapFS
	path string
}

func (e errorsOn) Open(name string) (fs.File, error) {
	if name == e.path {
		return nil, errors.New("permission denied")
	}
	return e.MapFS.Open(name)
}
