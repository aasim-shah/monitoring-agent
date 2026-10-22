module pcp.local/ingestgateway

go 1.23

require (
	github.com/golang/snappy v1.0.0
	google.golang.org/protobuf v1.36.11
	pcp.local/platform v0.0.0
)

replace pcp.local/platform => ../../packages/go-platform
