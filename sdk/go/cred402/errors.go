package cred402

import "fmt"

// APIError is the typed error returned by the SDK when the Cred402 API responds
// with a non-2xx status or an envelope whose "success" flag is false.
//
// The /v1 surface returns errors as
//
//	{"success":false,"error":{"code":"...","message":"..."},"request_id":"..."}
//
// while the raw /api surface and transport-level failures are surfaced with the
// HTTP status only. APIError unifies both into a single comparable value.
type APIError struct {
	// StatusCode is the HTTP status code returned by the server (0 if the
	// request never completed, e.g. a transport error).
	StatusCode int
	// Code is the machine-readable error code from the /v1 envelope
	// (e.g. "validation_error", "not_found"). Empty for raw /api errors.
	Code string
	// Message is a human-readable description of the failure.
	Message string
	// RequestID echoes the server-assigned request id when present, which is
	// useful for correlating client errors with server logs.
	RequestID string
}

// Error implements the error interface.
func (e *APIError) Error() string {
	switch {
	case e.Code != "" && e.RequestID != "":
		return fmt.Sprintf("cred402: %s (%s) [status=%d request_id=%s]", e.Message, e.Code, e.StatusCode, e.RequestID)
	case e.Code != "":
		return fmt.Sprintf("cred402: %s (%s) [status=%d]", e.Message, e.Code, e.StatusCode)
	default:
		return fmt.Sprintf("cred402: %s [status=%d]", e.Message, e.StatusCode)
	}
}

// IsNotFound reports whether the error represents a 404 / not_found response.
func (e *APIError) IsNotFound() bool {
	return e.StatusCode == 404 || e.Code == "not_found"
}

// IsValidation reports whether the error represents a request validation failure.
func (e *APIError) IsValidation() bool {
	return e.Code == "validation_error" || e.Code == "invalid_json"
}
