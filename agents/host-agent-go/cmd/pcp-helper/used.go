package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// UsedTasks remembers executed task IDs on disk for 24 h, so a task is single use even across
// helper restarts (BR-16-04). Tasks expire after 10 minutes, so 24 h is ample.
type UsedTasks struct {
	Path string
	mu   sync.Mutex
}

const usedRetention = 24 * time.Hour

// Claim records id as used; false when it was used before.
func (u *UsedTasks) Claim(id string, now time.Time) (bool, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	kept := []string{}
	if f, err := os.Open(u.Path); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			parts := strings.Fields(sc.Text())
			if len(parts) != 2 {
				continue
			}
			at, err := strconv.ParseInt(parts[1], 10, 64)
			if err != nil || now.Sub(time.Unix(at, 0)) > usedRetention {
				continue
			}
			if parts[0] == id {
				f.Close()
				return false, nil
			}
			kept = append(kept, sc.Text())
		}
		f.Close()
	} else if !os.IsNotExist(err) {
		return false, err
	}
	kept = append(kept, fmt.Sprintf("%s %d", id, now.Unix()))
	tmp := u.Path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(kept, "\n")+"\n"), 0o600); err != nil {
		return false, err
	}
	return true, os.Rename(tmp, u.Path)
}
