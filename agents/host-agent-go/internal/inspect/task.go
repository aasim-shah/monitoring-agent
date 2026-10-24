package inspect

import (
	"context"
	"fmt"

	"pcp.local/hostagent/internal/packs"
)

// targetPack is the pack each inspection target needs.
var targetPack = map[string]string{"redis": "redis", "kafka": "kafka", "kafka_peek": "kafka"}

// Run answers a signed inspect task with the endpoint and credentials of the pack applied on this
// host; it never connects anywhere a pack does not already point.
func Run(ctx context.Context, stateDir string, payload map[string]any) (any, error) {
	target, _ := payload["target"].(string)
	packID, _ := payload["packId"].(string)
	want, ok := targetPack[target]
	if !ok || packID != want {
		return nil, fmt.Errorf("inspection target %q is not supported for pack %q", target, packID)
	}
	store, err := packs.LoadStore(stateDir)
	if err != nil {
		return nil, err
	}
	for _, p := range store.Packs {
		if p.ID != packID {
			continue
		}
		endpoint, _ := p.Settings["endpoint"].(string)
		if endpoint == "" {
			return nil, fmt.Errorf("pack %s has no endpoint", packID)
		}
		switch target {
		case "redis":
			return Redis(ctx, endpoint, p.Credentials["password"], stringList(payload["keys"]))
		case "kafka":
			return Kafka(ctx, endpoint)
		default:
			topic, _ := payload["topic"].(string)
			limit, _ := payload["limit"].(float64)
			return Peek(ctx, endpoint, topic, stringList(payload["allowedTopics"]), int(limit))
		}
	}
	return nil, fmt.Errorf("pack %s is not applied on this host", packID)
}

func stringList(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, x := range list {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
