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
	"pcp.local/hostagent/internal/logs"
	"pcp.local/hostagent/internal/packs"
)

// Set at build time with -ldflags "-X main.version=…".
var version = "0.4.0"

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
	case "task-key":
		err = printTaskKey(os.Args[2:])
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
  pcp-agentctl collector-config [--state-dir DIR]   print the collector configuration
  pcp-agentctl task-key [--state-dir DIR]           print the platform task-signing public key`)
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
		for _, f := range []string{"agent.key", "x25519.key", "agent.crt", "chain.pem", "state.json", packs.StoreFile} {
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
	store, err := packs.LoadStore(*dir)
	if err != nil {
		log.Printf("ignoring unreadable %s: %v", packs.StoreFile, err)
		store = packs.Store{}
	}
	// A new agent starts at policy version 1 with no packs.
	var applied atomic.Int64
	applied.Store(int64(max(store.PolicyVersion, 1)))
	restart := make(chan struct{}, 1)
	collectorErr := startCollector(ctx, *collectorBin, *dir, st, store.Packs, restart)
	if collectorErr != nil {
		log.Printf("metrics disabled: %v", collectorErr)
	}
	applier := &packs.Applier{
		Dir:      *dir,
		Base:     collectorInput(*dir, st),
		Open:     func(sealed string) (map[string]string, error) { return control.OpenSealed(sealed, id) },
		Validate: packs.Validator(*collectorBin),
		Restart: func() {
			select {
			case restart <- struct{}{}:
			default:
			}
		},
	}
	pending := make(chan struct{}, 1)
	beat := func() {
		hb, err := client.Load().Heartbeat(ctx, proto.Heartbeat{Sequence: time.Now().UnixMilli(), AgentVersion: version, PolicyVersion: applied.Load(), Capabilities: []string{"host.health", "host.inventory", "packs"}, Health: "ok"})
		if err != nil {
			log.Printf("heartbeat: %v", err)
			return
		}
		if !hb.Accepted {
			log.Printf("heartbeat not accepted")
		}
		if int64(hb.PolicyVersion) != applied.Load() {
			select {
			case pending <- struct{}{}:
			default:
			}
		}
	}
	go applyPacks(ctx, &client, applier, collectorErr, pending, &applied)
	beat()
	log.Printf("agent %s running; heartbeats every 30 s", st.AgentID)
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
	// Live boosts end at their deadline even when the control plane is unreachable.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if applier.ExpireBoosts() {
					log.Printf("live boost ended; back to 30 s")
				}
			}
		}
	}()
	tails := make(chan struct{}, 2)
	actions := make(chan struct{}, 1)
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
			if t.Type == "action" {
				// Actions (service restarts) go to pcp-helper one at a time; the loop keeps polling.
				go func(t proto.AgentTask) {
					actions <- struct{}{}
					defer func() { <-actions }()
					res := forwardAction(ctx, helperSocket, t, 90*time.Second)
					if err := client.Load().PostResult(ctx, t.Id, res); err != nil {
						log.Printf("result for action %s: %v", t.Id, err)
					} else {
						log.Printf("action %s → %s %s", t.Id, res.Status, res.Error)
					}
				}(t)
				continue
			}
			if t.Type == "live_boost" {
				// One pack at 5 s until the deadline; the agent reverts on its own timer (BR-11-08).
				res := control.TaskResult{Status: "succeeded"}
				packID, _ := t.Payload["packId"].(string)
				until, _ := t.Payload["untilEpoch"].(float64)
				if err := applier.StartBoost(packID, time.Unix(int64(until), 0)); err != nil {
					res = control.TaskResult{Status: "failed", Error: err.Error()}
				}
				if err := c.PostResult(ctx, t.Id, res); err != nil {
					log.Printf("result for boost %s: %v", t.Id, err)
				} else {
					log.Printf("live boost %s for %s → %s %s", t.Id, packID, res.Status, res.Error)
				}
				continue
			}
			if t.Type == "log_tail" {
				// Live tails run beside the loop (at most 2 at once); the loop keeps polling.
				select {
				case tails <- struct{}{}:
					go func(t proto.AgentTask) {
						defer func() { <-tails }()
						runLogTail(ctx, &client, *dir, t)
					}(t)
				default:
					_ = c.PostResult(ctx, t.Id, control.TaskResult{Status: "failed", Error: "too many live tails on this host"})
				}
				continue
			}
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

// applyPacks fetches, applies, and acknowledges the pack configuration whenever a
// heartbeat reports a policy version other than the applied one. A failed fetch or ack
// leaves the applied version unchanged, so the next heartbeat retries.
func applyPacks(ctx context.Context, client *atomic.Pointer[control.Client], a *packs.Applier, collectorErr error, pending <-chan struct{}, applied *atomic.Int64) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-pending:
		}
		c := client.Load()
		cfg, err := c.Config(ctx)
		if err != nil {
			log.Printf("pack configuration: %v", err)
			continue
		}
		var ack control.ConfigAck
		if collectorErr != nil {
			ack = control.ConfigAck{PolicyVersion: cfg.PolicyVersion, Results: []control.PackResult{}}
			for _, p := range cfg.Packs {
				ack.Results = append(ack.Results, control.PackResult{PackId: p.PackId, Status: "failed", Message: "the collector is not installed on this host: " + collectorErr.Error()})
			}
		} else {
			ack = a.Apply(*cfg)
		}
		if err := c.AckConfig(ctx, ack); err != nil {
			log.Printf("pack acknowledgement: %v", err)
			continue
		}
		applied.Store(int64(cfg.PolicyVersion))
		for _, r := range ack.Results {
			log.Printf("pack %s: %s %s", r.PackId, r.Status, r.Message)
		}
	}
}

// runLogTail streams a redacted log source to the viewer until it closes, the task's
// runtime ends, or the agent stops (WB-12 UC-12-01).
func runLogTail(ctx context.Context, client *atomic.Pointer[control.Client], dir string, t proto.AgentTask) {
	store, _ := packs.LoadStore(dir)
	sessionID, _ := t.Payload["sessionId"].(string)
	ctx, cancel := context.WithTimeout(ctx, time.Duration(t.MaxRuntimeSeconds)*time.Second)
	defer cancel()
	post := func(seq int64, lines []string, final bool) error {
		err := client.Load().PostChunk(ctx, sessionID, seq, lines, final)
		var apiErr *control.APIError
		if errors.As(err, &apiErr) && apiErr.Status == 404 {
			return logs.ErrSessionClosed
		}
		return err
	}
	result, err := logs.RunTask(ctx, t.Payload, store.Packs, post, logs.Options{})
	res := control.TaskResult{Status: "succeeded", Result: result}
	if err != nil {
		res = control.TaskResult{Status: "failed", Error: err.Error()}
	}
	// The tail's own context may be over; report with a fresh one.
	rctx, rcancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer rcancel()
	if err := client.Load().PostResult(rctx, t.Id, res); err != nil {
		log.Printf("result for log tail %s: %v", t.Id, err)
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
		LogFiles:   logs.FilePaths,
		// Set by the Compose profile (UC-05-04), where / is mounted read-only at /hostfs.
		HostRoot: os.Getenv("PCP_HOST_ROOT"),
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
	in := collectorInput(*dir, st)
	if store, err := packs.LoadStore(*dir); err == nil {
		for _, p := range store.Packs {
			for k := range p.Credentials {
				p.Credentials[k] = "<redacted>"
			}
			in.Packs = append(in.Packs, p)
		}
	}
	cfg, err := collector.Config(in)
	if err != nil {
		return err
	}
	fmt.Println(string(cfg))
	return nil
}

// startCollector writes collector.yaml (host metrics and the packs applied last time)
// and keeps pcp-otelcol running until ctx ends; restart makes it reload the file.
func startCollector(ctx context.Context, bin, dir string, st *control.State, applied []collector.PackConfig, restart <-chan struct{}) error {
	if _, err := os.Stat(bin); err != nil {
		return fmt.Errorf("collector binary %s not found", bin)
	}
	in := collectorInput(dir, st)
	in.Packs = applied
	cfg, err := collector.Config(in)
	if err != nil {
		log.Printf("stored packs ignored: %v", err)
		in.Packs = nil
		if cfg, err = collector.Config(in); err != nil {
			return err
		}
	}
	path := dir + "/" + packs.ConfigFile
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		return err
	}
	sup := collector.Supervisor{
		Command: func() *exec.Cmd {
			cmd := exec.Command(bin, "--config", path)
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			return cmd
		},
		Sleep:   collector.SleepContext,
		Logf:    log.Printf,
		Restart: restart,
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

// printTaskKey prints the platform's task-signing public key (base64). The installer copies it,
// as root, to /etc/pcp-agent/task-signing.pub for pcp-helper, which never reads agent state.
func printTaskKey(args []string) error {
	fs := flag.NewFlagSet("task-key", flag.ExitOnError)
	dir := stateDirFlag(fs)
	_ = fs.Parse(args)
	st, err := control.LoadState(*dir)
	if err != nil {
		return err
	}
	if st.TaskSigningPublicKey == "" {
		return errors.New("this agent is not enrolled")
	}
	fmt.Println(st.TaskSigningPublicKey)
	return nil
}
