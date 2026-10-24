package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
)

// Handler is the runner's internal API; only the control API calls it, with the internal token.
func Handler(m *Manager, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sessions", func(w http.ResponseWriter, r *http.Request) {
		var req CreateRequest
		if !decode(w, r, &req) {
			return
		}
		pub, err := m.Create(req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"publicKey": pub})
	})
	mux.HandleFunc("POST /sessions/{id}/connect", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Password string `json:"password"`
		}
		if !decode(w, r, &req) {
			return
		}
		respond(w, m.Connect(r.PathValue("id"), req.Password))
	})
	mux.HandleFunc("POST /sessions/{id}/hosts/{hostId}/confirm", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Fingerprint string `json:"fingerprint"`
		}
		if !decode(w, r, &req) {
			return
		}
		respond(w, m.Confirm(r.PathValue("id"), r.PathValue("hostId"), req.Fingerprint))
	})
	mux.HandleFunc("DELETE /sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		m.Abort(r.PathValue("id"))
		w.WriteHeader(http.StatusNoContent)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid JSON body"))
		return false
	}
	return true
}

func respond(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		w.WriteHeader(http.StatusAccepted)
	case errors.Is(err, ErrNoSession), errors.Is(err, ErrNoHost):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, ErrNotConnected), errors.Is(err, ErrFingerprintMismatch):
		writeError(w, http.StatusConflict, err)
	default:
		writeError(w, http.StatusBadRequest, err)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"message": err.Error()})
}
