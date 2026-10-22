package discovery

import (
	"io"
	"io/fs"
	"strconv"
	"strings"
)

const (
	maxProcesses = 2000
	maxProcRead  = 4096
)

type process struct {
	PID     int
	Comm    string
	Cmdline string
}

// readProcesses reads comm and cmdline for at most maxProcesses PIDs. It opens
// nothing else under /proc/<pid>; unreadable processes (exited, permission) are skipped.
func readProcesses(fsys fs.FS) []process {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil
	}
	var out []process
	for _, e := range entries {
		if len(out) >= maxProcesses {
			break
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		comm, err := readSmall(fsys, e.Name()+"/comm")
		if err != nil {
			continue
		}
		cmdline, err := readSmall(fsys, e.Name()+"/cmdline")
		if err != nil {
			continue
		}
		out = append(out, process{
			PID:     pid,
			Comm:    strings.TrimSpace(comm),
			Cmdline: strings.TrimSpace(strings.ReplaceAll(cmdline, "\x00", " ")),
		})
	}
	return out
}

func readSmall(fsys fs.FS, name string) (string, error) {
	f, err := fsys.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxProcRead))
	return string(b), err
}
