package inspect

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"

	"pcp.local/hostagent/internal/logs"
)

// MaxPeek is the most messages one peek returns (UC-12-08).
const MaxPeek = 20

// maxPeekValue caps each peeked value after redaction.
const maxPeekValue = 1024

type TopicStat struct {
	Name              string `json:"name"`
	Partitions        int    `json:"partitions"`
	ReplicationFactor int    `json:"replicationFactor"`
	RetentionMs       *int64 `json:"retentionMs"`
	SizeBytes         *int64 `json:"sizeBytes"`
}

type GroupStat struct {
	Name    string `json:"name"`
	State   string `json:"state"`
	Members int    `json:"members"`
	Lag     int64  `json:"lag"`
}

// KafkaOverview is topics, partitions, sizes, and consumer-group lag: no message data.
type KafkaOverview struct {
	Brokers int         `json:"brokers"`
	Topics  []TopicStat `json:"topics"`
	Groups  []GroupStat `json:"groups"`
}

type PeekMessage struct {
	Partition int32  `json:"partition"`
	Offset    int64  `json:"offset"`
	At        int64  `json:"at"`
	Key       string `json:"key"`
	Value     string `json:"value"`
}

func kafkaClient(addr string, opts ...kgo.Opt) (*kgo.Client, error) {
	return kgo.NewClient(append([]kgo.Opt{kgo.SeedBrokers(addr), kgo.DialTimeout(5 * time.Second)}, opts...)...)
}

// Kafka describes the cluster behind one broker address with admin metadata calls only.
func Kafka(ctx context.Context, addr string) (*KafkaOverview, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cl, err := kafkaClient(addr)
	if err != nil {
		return nil, err
	}
	defer cl.Close()
	adm := kadm.NewClient(cl)
	meta, err := adm.Metadata(ctx)
	if err != nil {
		return nil, fmt.Errorf("cannot reach kafka at %s: %w", addr, err)
	}
	out := &KafkaOverview{Brokers: len(meta.Brokers)}
	var names []string
	for _, td := range meta.Topics.Sorted() {
		if td.IsInternal || td.Err != nil {
			continue
		}
		rf := 0
		for _, p := range td.Partitions {
			rf = max(rf, len(p.Replicas))
		}
		out.Topics = append(out.Topics, TopicStat{Name: td.Topic, Partitions: len(td.Partitions), ReplicationFactor: rf})
		names = append(names, td.Topic)
	}
	if len(names) > 0 {
		if cfgs, err := adm.DescribeTopicConfigs(ctx, names...); err == nil {
			for _, rc := range cfgs {
				for _, c := range rc.Configs {
					if c.Key == "retention.ms" && c.Value != nil {
						if ms, err := strconv.ParseInt(*c.Value, 10, 64); err == nil {
							setTopic(out, rc.Name, func(t *TopicStat) { t.RetentionMs = &ms })
						}
					}
				}
			}
		}
		if dirs, err := adm.DescribeAllLogDirs(ctx, nil); err == nil {
			sizes := map[string]int64{}
			dirs.Each(func(d kadm.DescribedLogDir) {
				d.Topics.Each(func(p kadm.DescribedLogDirPartition) { sizes[p.Topic] += p.Size })
			})
			for name, size := range sizes {
				setTopic(out, name, func(t *TopicStat) { s := size; t.SizeBytes = &s })
			}
		}
	}
	if groups, err := adm.ListGroups(ctx); err == nil && len(groups) > 0 {
		lags, err := adm.Lag(ctx, groups.Groups()...)
		if err == nil {
			for _, name := range groups.Groups() {
				l, ok := lags[name]
				if !ok {
					continue
				}
				out.Groups = append(out.Groups, GroupStat{Name: name, State: l.State, Members: len(l.Members), Lag: l.Lag.Total()})
			}
			sort.Slice(out.Groups, func(i, j int) bool { return out.Groups[i].Name < out.Groups[j].Name })
		}
	}
	return out, nil
}

func setTopic(o *KafkaOverview, name string, f func(*TopicStat)) {
	for i := range o.Topics {
		if o.Topics[i].Name == name {
			f(&o.Topics[i])
		}
	}
}

// Peek reads at most MaxPeek of the latest messages of an allowlisted topic, redacted on the host.
// It joins no consumer group and commits nothing.
func Peek(ctx context.Context, addr, topic string, allowed []string, n int) ([]PeekMessage, error) {
	if !ValidName(topic) || !contains(allowed, topic) {
		return nil, fmt.Errorf("topic %q is not allowlisted for message peek", topic)
	}
	n = min(max(n, 1), MaxPeek)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	admCl, err := kafkaClient(addr)
	if err != nil {
		return nil, err
	}
	adm := kadm.NewClient(admCl)
	ends, err := adm.ListEndOffsets(ctx, topic)
	if err != nil {
		admCl.Close()
		return nil, err
	}
	starts, err := adm.ListStartOffsets(ctx, topic)
	admCl.Close()
	if err != nil {
		return nil, err
	}
	from := map[int32]kgo.Offset{}
	want := 0
	ends.Each(func(e kadm.ListedOffset) {
		start := e.Offset
		if s, ok := starts.Lookup(topic, e.Partition); ok {
			start = s.Offset
		}
		first := max(start, e.Offset-int64(n))
		if e.Offset > first {
			from[e.Partition] = kgo.NewOffset().At(first)
			want += int(e.Offset - first)
		}
	})
	if want == 0 {
		return []PeekMessage{}, nil
	}
	cl, err := kafkaClient(addr, kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{topic: from}))
	if err != nil {
		return nil, err
	}
	defer cl.Close()
	var got []PeekMessage
	for len(got) < want && ctx.Err() == nil {
		fs := cl.PollFetches(ctx)
		fs.EachRecord(func(r *kgo.Record) {
			got = append(got, PeekMessage{
				Partition: r.Partition,
				Offset:    r.Offset,
				At:        r.Timestamp.UnixMilli(),
				Key:       clip(logs.Redact(string(r.Key))),
				Value:     clip(logs.Redact(string(r.Value))),
			})
		})
	}
	sort.Slice(got, func(i, j int) bool {
		if got[i].At != got[j].At {
			return got[i].At > got[j].At
		}
		return got[i].Offset > got[j].Offset
	})
	if len(got) > n {
		got = got[:n]
	}
	return got, nil
}

func clip(s string) string {
	if len(s) > maxPeekValue {
		return s[:maxPeekValue] + " …[truncated]"
	}
	return s
}
