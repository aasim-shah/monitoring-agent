module pcp.local/installerrunner

go 1.23.0

toolchain go1.23.12

require (
	golang.org/x/crypto v0.36.0
	pcp.local/platform v0.0.0
)

require golang.org/x/sys v0.31.0 // indirect

replace pcp.local/platform => ../../packages/go-platform
