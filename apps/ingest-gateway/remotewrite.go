package main

import (
	"errors"
	"math"

	"google.golang.org/protobuf/encoding/protowire"
)

// Minimal Prometheus remote_write 1.0 messages (prompb). Exemplars, histograms, and
// metadata are not carried in M6a and are dropped on decode.

type Label struct{ Name, Value string }

type Sample struct {
	Value     float64
	Timestamp int64 // milliseconds
}

type TimeSeries struct {
	Labels  []Label
	Samples []Sample
}

type WriteRequest struct{ Series []TimeSeries }

var errMalformed = errors.New("malformed remote_write request")

func decodeWriteRequest(b []byte) (*WriteRequest, error) {
	wr := &WriteRequest{}
	err := eachField(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		if num == 1 && typ == protowire.BytesType {
			ts, err := decodeSeries(v)
			if err != nil {
				return err
			}
			wr.Series = append(wr.Series, ts)
		}
		return nil
	})
	return wr, err
}

func decodeSeries(b []byte) (TimeSeries, error) {
	var ts TimeSeries
	err := eachField(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		switch {
		case num == 1 && typ == protowire.BytesType:
			var l Label
			if err := eachField(v, func(n protowire.Number, t protowire.Type, f []byte) error {
				if t == protowire.BytesType && n == 1 {
					l.Name = string(f)
				} else if t == protowire.BytesType && n == 2 {
					l.Value = string(f)
				}
				return nil
			}); err != nil {
				return err
			}
			ts.Labels = append(ts.Labels, l)
		case num == 2 && typ == protowire.BytesType:
			var s Sample
			if err := eachField(v, func(n protowire.Number, t protowire.Type, f []byte) error {
				if n == 1 && t == protowire.Fixed64Type {
					s.Value = math.Float64frombits(consumeFixed64Value(f))
				} else if n == 2 && t == protowire.VarintType {
					s.Timestamp = int64(consumeVarintValue(f))
				}
				return nil
			}); err != nil {
				return err
			}
			ts.Samples = append(ts.Samples, s)
		}
		return nil
	})
	return ts, err
}

// eachField walks a protobuf message. For fixed64 and varint fields, v holds the raw
// encoding, decoded by the protowire helpers below.
func eachField(b []byte, fn func(protowire.Number, protowire.Type, []byte) error) error {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return errMalformed
		}
		b = b[n:]
		var v []byte
		switch typ {
		case protowire.BytesType:
			val, m := protowire.ConsumeBytes(b)
			if m < 0 {
				return errMalformed
			}
			v, n = val, m
		case protowire.VarintType:
			_, m := protowire.ConsumeVarint(b)
			if m < 0 {
				return errMalformed
			}
			v, n = b[:m], m
		case protowire.Fixed64Type:
			_, m := protowire.ConsumeFixed64(b)
			if m < 0 {
				return errMalformed
			}
			v, n = b[:m], m
		default:
			m := protowire.ConsumeFieldValue(num, typ, b)
			if m < 0 {
				return errMalformed
			}
			n = m
		}
		if err := fn(num, typ, v); err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

func (wr *WriteRequest) encode() []byte {
	var out []byte
	for _, ts := range wr.Series {
		var s []byte
		for _, l := range ts.Labels {
			var lb []byte
			lb = protowire.AppendTag(lb, 1, protowire.BytesType)
			lb = protowire.AppendString(lb, l.Name)
			lb = protowire.AppendTag(lb, 2, protowire.BytesType)
			lb = protowire.AppendString(lb, l.Value)
			s = protowire.AppendTag(s, 1, protowire.BytesType)
			s = protowire.AppendBytes(s, lb)
		}
		for _, smp := range ts.Samples {
			var sb []byte
			sb = protowire.AppendTag(sb, 1, protowire.Fixed64Type)
			sb = protowire.AppendFixed64(sb, math.Float64bits(smp.Value))
			sb = protowire.AppendTag(sb, 2, protowire.VarintType)
			sb = protowire.AppendVarint(sb, uint64(smp.Timestamp))
			s = protowire.AppendTag(s, 2, protowire.BytesType)
			s = protowire.AppendBytes(s, sb)
		}
		out = protowire.AppendTag(out, 1, protowire.BytesType)
		out = protowire.AppendBytes(out, s)
	}
	return out
}

func consumeFixed64Value(b []byte) uint64 { v, _ := protowire.ConsumeFixed64(b); return v }
func consumeVarintValue(b []byte) uint64  { v, _ := protowire.ConsumeVarint(b); return v }
