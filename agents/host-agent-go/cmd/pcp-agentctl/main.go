// Command pcp-agentctl enrolls a host with the Product Control Plane and runs the
// control loop: heartbeats every 30 s, signed task long-polling, and certificate
// rotation before expiry. M6 adds the collector, supervisor, and installer around it.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	proto "pcp.local/agentprotocol"
	"pcp.local/hostagent/internal/collector"
	"pcp.local/hostagent/internal/control"
	"pcp.local/hostagent/internal/discovery"
)

// Set at build time with -ldflags "-X main.version=…".
var version = "0.1.0"

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "enroll":
		err = enroll(os.Args[2:])
	case "run":
		err = run(os.Args[2:])
	case "status":
		err = status(os.Args[2:])
	case "collector-config":
		err = printCollectorConfig(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		log.Fatal(err)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  pcp-agentctl enroll --token TOKEN --control-url URL [--state-dir DIR] [--server-name NAME] [--ca-file FILE] [--force]
  pcp-agentctl run    [--state-dir DIR]
  pcp-agentctl status [--state-dir DIR]
  pcp-agentctl collector-config [--state-dir DIR]   print the collector configuration`)
	os.Exit(2)
}

func stateDirFlag(fs *flag.FlagSet) *string {
	return fs.String("state-dir", "/var/lib/pcp-agent", "directory for keys, certificate, and state (mode 0700)")
}

func enroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	dir := stateDirFlag(fs)
	token := fs.String("token", "", "one-time enrollment token from the dashboard")
	url := fs.String("control-url", "", "control plane URL, e.g. https://agent.example.com")
	serverName := fs.String("server-name", "", "TLS server name when connecting by IP (development)")
	caFile := fs.String("ca-file", "", "extra TLS root for a development control plane")
	ingestURL := fs.String("ingest-url", "", "override the ingest URL from enrollment (development)")
	force := fs.Bool("force", false, "replace an existing identity on this host")
	_ = fs.Parse(args)
	if *token == "" || *url == "" {
		return errors.New("--token and --control-url are required")
	}
	if *force {
		for _, f := range []string{"agent.key", "x25519.key", "agent.crt", "chain.pem", "state.json"} {
			_ = os.Remove(*dir + "/" + f)
		}
	}
	id, err := control.GenerateIdentity(*dir)
	if err != nil {
		return err
	}
	base, err := control.ServerTLS(*serverName, *caFile)
	if err != nil {
		return err
	}
	var opts []control.Option
	if *serverName != "" {
		opts = append(opts, control.WithServerName(*serverName))
	}
	hostname, _ := os.Hostname()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	res, err := control.New(*url, control.HTTPClient(base), opts...).Enroll(ctx, *token, id, proto.EnrollRequestHost{
		Hostname:  hostname,
		MachineId: machineID(),
		Os:        osName(),
		Arch:      runtime.GOARCH,
	}, version)
	if err != nil {
		_ = os.Remove(*dir + "/agent.key")
		_ = os.Remove(*dir + "/x25519.key")
		return fmt.Errorf("enrollment failed: %w", err)
	}
	if err := id.SaveCertificate(res.CertificatePem, res.ChainPem); err != nil {
		return err
	}
	ingest := res.IngestUrl
	if *ingestURL != "" {
		ingest = *ingestURL
	}
	if err := control.SaveState(*dir, &control.State{
		AgentID: res.AgentId, ControlURL: *url, IngestURL: ingest, OpampURL: res.OpampUrl,
		TaskSigningPublicKey: res.TaskSigningPublicKey, NotAfter: res.NotAfter, ServerName: *serverName, CAFile: *caFile,
	}); err != nil {
		return err
	}
	log.Printf("enrolled as agent %s; certificate valid until %s", res.AgentId, res.NotAfter)
	return nil
}

func run(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	dir := stateDirFlag(fs)
	collectorBin := fs.String("collector", "/usr/local/bin/pcp-otelcol", "collector binary; metrics are skipped when it is missing")
	_ = fs.Parse(args)
	st, err := control.LoadState(*dir)
	if err != nil {
		return err
	}
	c0, id, err := control.Connect(*dir, st)
	if err != nil {
		return err
	}
	// Rotation swaps the client while the heartbeat and inventory goroutines use it.
	var client atomic.Pointer[control.Client]
	client.Store(c0)
	key, err := base64.StdEncoding.DecodeString(st.TaskSigningPublicKey)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	started := time.Now()
	// Millisecond timestamps keep the sequence increasing across restarts and stay below 2^53.
	beat := func() {
		ok, err := client.Load().Heartbeat(ctx, proto.Heartbeat{Sequence: time.Now().UnixMilli(), AgentVersion: version, PolicyVersion: 1, Capabilities: []string{"host.health", "host.inventory"}, Health: "ok"})
		if err != nil {
			log.Printf("heartbeat: %v", err)
		} else if !ok {
			log.Printf("heartbeat not accepted")
		}
	}
	beat()
	log.Printf("agent %s running; heartbeats every 30 s", st.AgentID)
	if err := startCollector(ctx, *collectorBin, *dir, st); err != nil {
		log.Printf("metrics disabled: %v", err)
	}
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				beat()
			}
		}
	}()
	go reportInventory(ctx, &client)
	for ctx.Err() == nil {
		c := client.Load()
		if rotated, err := rotateIfDue(ctx, c, id, st, *dir); err != nil {
			log.Printf("rotation: %v", err)
		} else if rotated != nil {
			client.Store(rotated)
			c = rotated
		}
		tasks, rejected, err := c.PollTasks(ctx, 25*time.Second, ed25519.PublicKey(key))
		var apiErr *control.APIError
		if errors.As(err, &apiErr) && apiErr.Status == 401 {
			return errors.New("the control plane rejected this agent (revoked or certificate expired); re-enroll with --force")
		}
		if err != nil {
			log.Printf("poll: %v", err)
			sleep(ctx, 5*time.Second)
			continue
		}
		if rejected > 0 {
			log.Printf("dropped %d task(s) with a bad signature or past expiry", rejected)
		}
		for _, t := range tasks {
			res := handle(t, st, started)
			if err := c.PostResult(ctx, t.Id, res); err != nil {
				log.Printf("result for %s: %v", t.Id, err)
			} else {
				log.Printf("task %s (%s) → %s", t.Id, t.Type, res.Status)
			}
		}
	}
	return nil
}

// reportInventory posts what discovery finds in /proc at start and every 5 minutes.
// Failures are logged and retried on the next tick.
func reportInventory(ctx context.Context, client *atomic.Pointer[control.Client]) {
	procfs := os.DirFS("/proc")
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		inv, err := discovery.Scan(procfs, time.Now())
		if err == nil {
			err = client.Load().PostInventory(ctx, inv)
		}
		if err != nil && ctx.Err() == nil {
			log.Printf("inventory: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// handle answers the task types this build supports; others fail explicitly.
func handle(t proto.AgentTask, st *control.State, started time.Time) control.TaskResult {
	if t.Type == "inspect" && t.Payload["target"] == "agent_info" {
		hostname, _ := os.Hostname()
		return control.TaskResult{Status: "succeeded", Result: map[string]any{
			"agentId":       st.AgentID,
			"hostname":      hostname,
			"os":            osName(),
			"arch":          runtime.GOARCH,
			"agentVersion":  version,
			"uptimeSeconds": int64(time.Since(started).Seconds()),
			"cpus":          runtime.NumCPU(),
		}}
	}
	return control.TaskResult{Status: "failed", Error: fmt.Sprintf("task type %s is not supported by agent %s", t.Type, version)}
}

// rotateIfDue renews the certificate 10 days before expiry (day 20 of 30, §3).
func rotateIfDue(ctx context.Context, c *control.Client, id *control.Identity, st *control.State, dir string) (*control.Client, error) {
	notAfter, err := time.Parse(time.RFC3339Nano, st.NotAfter)
	if err != nil || time.Until(notAfter) > 10*24*time.Hour {
		return nil, nil
	}
	if err := id.Rekey(); err != nil {
		return nil, err
	}
	res, err := c.Rotate(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := id.SaveCertificate(res.CertificatePem, res.ChainPem); err != nil {
		return nil, err
	}
	st.NotAfter = res.NotAfter
	if err := control.SaveState(dir, st); err != nil {
		return nil, err
	}
	log.Printf("certificate rotated; valid until %s", res.NotAfter)
	next, _, err := control.Connect(dir, st)
	return next, err
}

func collectorInput(dir string, st *control.State) collector.Input {
	serverName := ""
	if st.ServerName != "" {
		serverName = "ingest." + strings.TrimPrefix(st.ServerName, "agent.")
	}
	return collector.Input{
		IngestURL:  st.IngestURL,
		CertFile:   dir + "/agent.crt",
		KeyFile:    dir + "/agent.key",
		CAFile:     st.CAFile,
		ServerName: serverName,
		StorageDir: dir,
	}
}

// printCollectorConfig shows the configuration `run` would give the collector.
func printCollectorConfig(args []string) error {
	fs := flag.NewFlagSet("collector-config", flag.ExitOnError)
	dir := stateDirFlag(fs)
	_ = fs.Parse(args)
	st, err := control.LoadState(*dir)
	if err != nil {
		return err
	}
	cfg, err := collector.Config(collectorInput(*dir, st))
	if err != nil {
		return err
	}
	fmt.Println(string(cfg))
	return nil
}

// startCollector writes collector.yaml and keeps pcp-otelcol running until ctx ends.
func startCollector(ctx context.Context, bin, dir string, st *control.State) error {
	if _, err := os.Stat(bin); err != nil {
		return fmt.Errorf("collector binary %s not found", bin)
	}
	cfg, err := collector.Config(collectorInput(dir, st))
	if err != nil {
		return err
	}
	path := dir + "/collector.yaml"
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		return err
	}
	sup := collector.Supervisor{
		Command: func() *exec.Cmd {
			cmd := exec.Command(bin, "--config", path)
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			return cmd
		},
		Sleep: collector.SleepContext,
		Logf:  log.Printf,
	}
	go sup.Run(ctx)
	log.Printf("collector started; host metrics every 30 s to %s", st.IngestURL)
	return nil
}

func status(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	dir := stateDirFlag(fs)
	_ = fs.Parse(args)
	st, err := control.LoadState(*dir)
	if err != nil {
		return err
	}
	c, _, err := control.Connect(*dir, st)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	agentID, err := c.Whoami(ctx)
	if err != nil {
		return fmt.Errorf("agent %s cannot authenticate: %w", st.AgentID, err)
	}
	fmt.Printf("agent %s connected to %s; certificate valid until %s\n", agentID, st.ControlURL, st.NotAfter)
	return nil
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func machineID() string {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	h, _ := os.Hostname()
	return "unknown-" + h
}

func osName() string {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return runtime.GOOS
	}
	var id, ver string
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "ID="); ok {
			id = strings.Trim(v, `"`)
		}
		if v, ok := strings.CutPrefix(line, "VERSION_ID="); ok {
			ver = strings.Trim(v, `"`)
		}
	}
	if id == "" {
		return runtime.GOOS
	}
	return strings.TrimSuffix(id+"-"+ver, "-")
}
