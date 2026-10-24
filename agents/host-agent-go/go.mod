module pcp.local/hostagent

go 1.23

require (
	github.com/twmb/franz-go v1.18.1
	github.com/twmb/franz-go/pkg/kadm v1.15.0
	github.com/twmb/franz-go/pkg/kfake v0.0.0-20250121001354-6ea03e3a3810
	pcp.local/agentprotocol v0.0.0
)

require (
	github.com/klauspost/compress v1.17.11 // indirect
	github.com/pierrec/lz4/v4 v4.1.22 // indirect
	github.com/twmb/franz-go/pkg/kmsg v1.9.0 // indirect
	golang.org/x/crypto v0.32.0 // indirect
)

replace pcp.local/agentprotocol => ../../packages/agent-protocol/go
