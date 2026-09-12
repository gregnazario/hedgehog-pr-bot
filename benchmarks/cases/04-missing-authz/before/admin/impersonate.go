package admin

import (
	"net/http"
)

func Impersonate(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	startSession(w, r.URL.Query().Get("user"))
	w.WriteHeader(http.StatusNoContent)
}
