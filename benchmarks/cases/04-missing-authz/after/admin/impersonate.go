package admin

import (
	"net/http"
)

func Impersonate(w http.ResponseWriter, r *http.Request) {
	startSession(w, r.URL.Query().Get("user"))
	w.WriteHeader(http.StatusNoContent)
}
