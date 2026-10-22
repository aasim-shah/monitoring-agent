// Package discovery finds the services a host runs from /proc (listening sockets,
// process names, and command lines) and matches them to monitoring packs
// (spec §8.6, master plan M6.3). It never reads /proc/<pid>/environ (BR-11-02).
package discovery

import "strings"

// Rule says how a pack's service shows up on a host.
type Rule struct {
	Pack  string
	Name  string
	Ports []int64
	// Sensitive packs (databases, caches, brokers) warn when bound beyond loopback.
	Sensitive bool
	Match     func(comm, cmdline string) bool
}

func commIs(names ...string) func(string, string) bool {
	return func(comm, _ string) bool {
		for _, n := range names {
			if comm == n {
				return true
			}
		}
		return false
	}
}

// Catalog lists the packs discovery can detect, in display order.
var Catalog = []Rule{
	{Pack: "redis", Name: "Redis", Ports: []int64{6379}, Sensitive: true, Match: commIs("redis-server")},
	{Pack: "postgresql", Name: "PostgreSQL", Ports: []int64{5432}, Sensitive: true, Match: commIs("postgres")},
	{Pack: "mysql", Name: "MySQL", Ports: []int64{3306}, Sensitive: true, Match: commIs("mysqld", "mariadbd")},
	{Pack: "mongodb", Name: "MongoDB", Ports: []int64{27017}, Sensitive: true, Match: commIs("mongod")},
	{Pack: "kafka", Name: "Kafka", Ports: []int64{9092}, Sensitive: true, Match: func(comm, cmdline string) bool {
		return comm == "java" && strings.Contains(cmdline, "kafka.Kafka")
	}},
	{Pack: "nginx", Name: "nginx", Ports: []int64{80, 443}, Match: commIs("nginx")},
	{Pack: "nodejs", Name: "Node.js", Match: func(comm, _ string) bool {
		return comm == "node" || strings.HasPrefix(comm, "PM2")
	}},
}
