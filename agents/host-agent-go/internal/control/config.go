package control

import (
	"context"
	"net/http"
)

// PackAssignment is one enabled pack as the control plane sends it. SealedCredentials
// is present only until the agent acknowledges a version that includes it.
type PackAssignment struct {
	PackId            string         `json:"packId"`
	Settings          map[string]any `json:"settings"`
	SealedCredentials string         `json:"sealedCredentials,omitempty"`
}

// AgentConfig is the pack configuration for a policy version.
type AgentConfig struct {
	PolicyVersion int              `json:"policyVersion"`
	Packs         []PackAssignment `json:"packs"`
}

// PackResult reports whether one pack was applied.
type PackResult struct {
	PackId  string `json:"packId"`
	Status  string `json:"status"` // applied | failed
	Message string `json:"message,omitempty"`
}

// ConfigAck acknowledges a policy version.
type ConfigAck struct {
	PolicyVersion int          `json:"policyVersion"`
	Results       []PackResult `json:"results"`
}

// Config fetches the current pack configuration.
func (c *Client) Config(ctx context.Context) (*AgentConfig, error) {
	var out AgentConfig
	if err := c.do(ctx, http.MethodGet, "/agent/v1/config", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AckConfig reports the outcome; the control plane then deletes the ciphertext.
func (c *Client) AckConfig(ctx context.Context, ack ConfigAck) error {
	if ack.Results == nil {
		ack.Results = []PackResult{}
	}
	return c.do(ctx, http.MethodPost, "/agent/v1/config/ack", ack, nil)
}
