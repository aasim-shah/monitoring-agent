package main

import (
	"sync"
	"time"
)

// SeriesLimiter counts distinct series per agent and per tenant in hourly windows
// (D15: in-memory, single replica). A request that would add series beyond either limit
// is refused as a whole; requests containing only known series always pass (BR-04-04).
type SeriesLimiter struct {
	AgentMax, TenantMax int

	mu     sync.Mutex
	window int64
	agents map[string]map[string]struct{}
	tenant map[string]int
}

func (l *SeriesLimiter) Admit(now time.Time, agent, tenant string, keys []string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if w := now.Unix() / 3600; w != l.window || l.agents == nil {
		l.window, l.agents, l.tenant = w, map[string]map[string]struct{}{}, map[string]int{}
	}
	known := l.agents[agent]
	if known == nil {
		known = map[string]struct{}{}
		l.agents[agent] = known
	}
	fresh := map[string]struct{}{}
	for _, k := range keys {
		if _, ok := known[k]; !ok {
			fresh[k] = struct{}{}
		}
	}
	if len(fresh) == 0 {
		return true
	}
	if len(known)+len(fresh) > l.AgentMax || l.tenant[tenant]+len(fresh) > l.TenantMax {
		return false
	}
	for k := range fresh {
		known[k] = struct{}{}
	}
	l.tenant[tenant] += len(fresh)
	return true
}

// Active returns the tenant's distinct series admitted in the current hour.
func (l *SeriesLimiter) Active(now time.Time, tenant string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Unix()/3600 != l.window {
		return 0
	}
	return l.tenant[tenant]
}

// SampleLimiter is a per-agent token bucket: Rate samples/s with a 10 s burst.
type SampleLimiter struct {
	Rate float64

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// Allow takes n samples; when refused it returns how long until they would fit.
func (l *SampleLimiter) Allow(now time.Time, agent string, n int) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = map[string]*bucket{}
	}
	burst := l.Rate * 10
	b := l.buckets[agent]
	if b == nil {
		b = &bucket{tokens: burst, last: now}
		l.buckets[agent] = b
	}
	b.tokens = min(burst, b.tokens+now.Sub(b.last).Seconds()*l.Rate)
	b.last = now
	if float64(n) > b.tokens {
		wait := time.Duration((float64(n) - b.tokens) / l.Rate * float64(time.Second))
		return false, max(wait, time.Second)
	}
	b.tokens -= float64(n)
	return true, 0
}
