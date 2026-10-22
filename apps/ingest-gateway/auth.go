package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Identity is the tenant scope the control plane assigned to an agent at enrollment.
type Identity struct {
	AgentID        string `json:"agentId"`
	OrganizationID string `json:"organizationId"`
	ProductID      string `json:"productId"`
	EnvironmentID  string `json:"environmentId"`
}

var errUnknownAgent = errors.New("unknown, revoked, or expired agent certificate")

// Resolver maps a client-certificate fingerprint to an agent identity.
type Resolver interface {
	Resolve(ctx context.Context, fingerprint string) (*Identity, error)
}

// APIResolver asks the API's internal endpoint and caches answers (including "unknown")
// for 30 s, so revocation reaches the gateway within that window (BR-03-05).
type APIResolver struct {
	BaseURL string
	Token   string
	Client  *http.Client
	Now     func() time.Time

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	id      *Identity
	expires time.Time
}

const resolveTTL = 30 * time.Second

func (r *APIResolver) Resolve(ctx context.Context, fp string) (*Identity, error) {
	now := r.Now()
	r.mu.Lock()
	if c, ok := r.cache[fp]; ok && now.Before(c.expires) {
		r.mu.Unlock()
		if c.id == nil {
			return nil, errUnknownAgent
		}
		return c.id, nil
	}
	r.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.BaseURL+"/internal/agents/by-fingerprint/"+fp, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Internal-Token", r.Token)
	res, err := r.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("identity lookup: %w", err)
	}
	defer res.Body.Close()
	var id *Identity
	switch res.StatusCode {
	case http.StatusOK:
		id = &Identity{}
		if err := json.NewDecoder(res.Body).Decode(id); err != nil {
			return nil, err
		}
	case http.StatusNotFound:
	default:
		return nil, fmt.Errorf("identity lookup: status %d", res.StatusCode)
	}
	r.mu.Lock()
	if r.cache == nil || len(r.cache) > 50_000 {
		r.cache = map[string]cached{}
	}
	r.cache[fp] = cached{id: id, expires: now.Add(resolveTTL)}
	r.mu.Unlock()
	if id == nil {
		return nil, errUnknownAgent
	}
	return id, nil
}
