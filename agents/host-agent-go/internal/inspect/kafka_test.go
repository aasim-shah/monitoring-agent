package inspect

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
)

func fakeKafka(t *testing.T) string {
	t.Helper()
	c, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.SeedTopics(2, "orders", "audit"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	addr := c.ListenAddrs()[0]
	cl, err := kgo.NewClient(kgo.SeedBrokers(addr))
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	ctx := context.Background()
	for i := 0; i < 30; i++ {
		v := fmt.Sprintf(`{"order":%d,"email":"buyer%d@example.com","token":"sk-live_abcdefghijklmnop%02d"}`, i, i, i)
		if err := cl.ProduceSync(ctx, &kgo.Record{Topic: "orders", Value: []byte(v)}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	// A consumer group that read 10 of the 30 orders.
	g, err := kgo.NewClient(kgo.SeedBrokers(addr), kgo.ConsumerGroup("billing"), kgo.ConsumeTopics("orders"), kgo.DisableAutoCommit())
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	read := 0
	for read < 10 {
		fs := g.PollRecords(ctx, 10-read)
		fs.EachRecord(func(r *kgo.Record) {
			if read < 10 {
				read++
				_ = g.CommitRecords(ctx, r)
			}
		})
	}
	return addr
}

func TestKafkaOverviewShowsTopicsAndGroupLagOnly(t *testing.T) {
	addr := fakeKafka(t)
	got, err := Kafka(context.Background(), addr)
	if err != nil {
		t.Fatal(err)
	}
	if got.Brokers != 1 {
		t.Errorf("brokers = %d", got.Brokers)
	}
	topics := map[string]TopicStat{}
	for _, tp := range got.Topics {
		topics[tp.Name] = tp
	}
	if topics["orders"].Partitions != 2 || topics["audit"].Partitions != 2 {
		t.Errorf("topics = %+v", got.Topics)
	}
	if len(got.Groups) != 1 || got.Groups[0].Name != "billing" || got.Groups[0].Lag != 20 {
		t.Errorf("groups = %+v", got.Groups)
	}
	if out := fmt.Sprintf("%+v", got); strings.Contains(out, "example.com") || strings.Contains(out, "sk-live") {
		t.Errorf("message data in overview: %s", out)
	}
}

// UC-12-08, TC-12-07: only allowlisted topics, at most 20 messages, redacted on the host.
func TestPeekIsAllowlistedCappedAndRedacted(t *testing.T) {
	addr := fakeKafka(t)
	if _, err := Peek(context.Background(), addr, "audit", []string{"orders"}, 20); err == nil {
		t.Error("peek on a topic that is not allowlisted")
	}
	msgs, err := Peek(context.Background(), addr, "orders", []string{"orders"}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != MaxPeek {
		t.Fatalf("%d messages, want %d", len(msgs), MaxPeek)
	}
	for _, m := range msgs {
		if strings.Contains(m.Value, "@example.com") || strings.Contains(m.Value, "sk-live_") {
			t.Fatalf("not redacted: %s", m.Value)
		}
		if !strings.Contains(m.Value, `"order"`) {
			t.Fatalf("value lost: %s", m.Value)
		}
	}
}
