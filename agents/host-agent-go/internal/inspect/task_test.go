package inspect

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"pcp.local/hostagent/internal/collector"
)

func storeWith(t *testing.T, packs ...collector.PackConfig) string {
	t.Helper()
	dir := t.TempDir()
	data, _ := json.Marshal(map[string]any{"policyVersion": 1, "packs": packs})
	if err := os.WriteFile(filepath.Join(dir, "packs.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRunUsesTheAppliedPackEndpointAndCredentials(t *testing.T) {
	r := newFakeRedis(t, "pw")
	k := fakeKafka(t)
	dir := storeWith(t,
		collector.PackConfig{ID: "redis", Settings: map[string]any{"endpoint": r.addr}, Credentials: map[string]string{"password": "pw"}},
		collector.PackConfig{ID: "kafka", Settings: map[string]any{"endpoint": k}},
	)
	res, err := Run(context.Background(), dir, map[string]any{"target": "redis", "packId": "redis", "keys": []any{"jobs"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.(*RedisStats).DBSize != 42 {
		t.Errorf("redis = %+v", res)
	}
	res, err = Run(context.Background(), dir, map[string]any{"target": "kafka", "packId": "kafka"})
	if err != nil || len(res.(*KafkaOverview).Topics) != 2 {
		t.Errorf("kafka = %+v %v", res, err)
	}
	res, err = Run(context.Background(), dir, map[string]any{"target": "kafka_peek", "packId": "kafka", "topic": "orders", "allowedTopics": []any{"orders"}, "limit": float64(5)})
	if err != nil || len(res.([]PeekMessage)) != 5 {
		t.Errorf("peek = %+v %v", res, err)
	}
}

func TestRunRefusesPacksThatAreNotAppliedOrNotInspectable(t *testing.T) {
	dir := storeWith(t, collector.PackConfig{ID: "postgresql", Settings: map[string]any{"endpoint": "127.0.0.1:5432"}})
	for _, p := range []map[string]any{
		{"target": "redis", "packId": "redis"},
		{"target": "redis", "packId": "postgresql"},
		{"target": "shell", "packId": "postgresql"},
	} {
		if _, err := Run(context.Background(), dir, p); err == nil {
			t.Errorf("%v accepted", p)
		}
	}
}
