package discovery

import (
	"fmt"
	"io/fs"
	"net"
	"time"

	proto "pcp.local/agentprotocol"
)

type (
	Inventory = proto.Inventory
	Service   = proto.InventoryServices
)

const (
	maxServices = 100
	maxPorts    = 50
	maxEvidence = 10
	maxWarnings = 100
)

// Scan reads a procfs-shaped file system (os.DirFS("/proc") on a host) and returns
// the services it finds, every TCP listener, and warnings for sensitive services
// bound beyond loopback. Unreadable entries are skipped; output is bounded.
func Scan(fsys fs.FS, now time.Time) (Inventory, error) {
	listeners := readListeners(fsys)
	procs := readProcesses(fsys)
	inv := Inventory{
		CollectedAt: now.UTC().Format(time.RFC3339),
		Services:    []Service{},
		Listeners:   make([]proto.InventoryListeners, 0, len(listeners)),
		Warnings:    []proto.InventoryWarnings{},
	}
	for _, l := range listeners {
		inv.Listeners = append(inv.Listeners, proto.InventoryListeners{Address: l.Address, Port: l.Port})
	}
	for _, rule := range Catalog {
		svc, ok := match(rule, procs, listeners)
		if !ok || len(inv.Services) >= maxServices {
			continue
		}
		inv.Services = append(inv.Services, svc)
		if !rule.Sensitive {
			continue
		}
		for _, p := range svc.Ports {
			if !isLoopback(p.Address) && len(inv.Warnings) < maxWarnings {
				inv.Warnings = append(inv.Warnings, proto.InventoryWarnings{
					Kind: "exposed_service", Pack: rule.Pack, Address: p.Address, Port: p.Port,
				})
			}
		}
	}
	return inv, nil
}

func match(rule Rule, procs []process, listeners []listener) (Service, bool) {
	svc := Service{Pack: rule.Pack, Name: rule.Name, Ports: []proto.InventoryServicesPorts{}, Evidence: []string{}}
	for _, p := range procs {
		if !rule.Match(p.Comm, p.Cmdline) {
			continue
		}
		if svc.ProcessCount == 0 {
			svc.Evidence = append(svc.Evidence, truncate(fmt.Sprintf("process %s (pid %d)", p.Comm, p.PID), 200))
		}
		svc.ProcessCount++
	}
	if svc.ProcessCount == 0 {
		return Service{}, false
	}
	for _, l := range listeners {
		if !hasPort(rule.Ports, l.Port) || len(svc.Ports) >= maxPorts {
			continue
		}
		svc.Ports = append(svc.Ports, proto.InventoryServicesPorts{Address: l.Address, Port: l.Port})
		if len(svc.Evidence) < maxEvidence {
			svc.Evidence = append(svc.Evidence, fmt.Sprintf("listening on %s", net.JoinHostPort(l.Address, fmt.Sprint(l.Port))))
		}
	}
	return svc, true
}

func hasPort(ports []int64, port int64) bool {
	for _, p := range ports {
		if p == port {
			return true
		}
	}
	return false
}

func isLoopback(addr string) bool {
	ip := net.ParseIP(addr)
	return ip != nil && ip.IsLoopback()
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
