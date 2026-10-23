package logs

import (
	"encoding/json"
	"os"
	"testing"

	"pcp.local/hostagent/internal/collector"
)

// The API mirrors this table; both are pinned to the shared fixture.
func TestSourcesMatchSharedFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/agent-protocol/testdata/log-sources.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Packs  map[string][]string `json:"packs"`
		Always []string            `json:"always"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Packs) != len(packSources) {
		t.Fatalf("fixture has %d packs, agent has %d", len(fx.Packs), len(packSources))
	}
	for pack, want := range fx.Packs {
		got := packSources[pack]
		if len(got) != len(want) {
			t.Fatalf("%s: fixture %v, agent %v", pack, want, got)
		}
		for i := range want {
			if got[i].ID != want[i] {
				t.Fatalf("%s[%d]: fixture %q, agent %q", pack, i, want[i], got[i].ID)
			}
		}
	}
	all := Sources(nil)
	if len(all) != len(fx.Always) || all[0].ID != fx.Always[0] {
		t.Fatalf("always-on sources: fixture %v, agent %v", fx.Always, all)
	}
	if got := Sources([]collector.PackConfig{{ID: "nginx"}}); len(got) != 3 || got[0].ID != "nginx.access" {
		t.Fatalf("nginx sources: %v", got)
	}
}
