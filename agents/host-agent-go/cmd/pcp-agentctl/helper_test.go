package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"

	proto "pcp.local/agentprotocol"
)

func TestForwardsActionTasksToTheHelperUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan map[string]any, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, _ := bufio.NewReader(conn).ReadBytes('\n')
		var task map[string]any
		_ = json.Unmarshal(line, &task)
		got <- task
		_, _ = conn.Write([]byte(`{"status":"succeeded","result":{"unit":"api.service","activeState":"active"}}` + "\n"))
	}()
	task := proto.AgentTask{Id: "t1", Type: "action", ExpiresAt: "2026-10-24T10:10:00Z", Payload: map[string]any{"capability": "service_restart", "unit": "api.service"}, Signature: "sig"}
	res := forwardAction(context.Background(), path, task, 5*time.Second)
	if res.Status != "succeeded" || res.Result["activeState"] != "active" {
		t.Fatalf("%+v", res)
	}
	sent := <-got
	if sent["signature"] != "sig" || sent["id"] != "t1" {
		t.Fatalf("forwarded %v", sent)
	}
}

func TestExplainsAMissingHelper(t *testing.T) {
	res := forwardAction(context.Background(), filepath.Join(t.TempDir(), "none.sock"), proto.AgentTask{Id: "t2", Type: "action"}, time.Second)
	if res.Status != "failed" || res.Error != "pcp-helper is not installed on this host (re-run the installer with --enable-helper)" {
		t.Fatalf("%+v", res)
	}
}
