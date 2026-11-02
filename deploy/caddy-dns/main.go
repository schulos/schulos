// SchulOS: Caddy mit DNS-Modulen für öffentliche Zertifikate per ACME DNS-01 (CA-07, docs/ZERTIFIKATE.md Teil B).
// Genau das Hauptprogramm, das `xcaddy build --with …` erzeugt – hier mit go.mod/go.sum im Repo, damit jede Abhängigkeit
// per Prüfsumme festliegt und Dependabot (gomod) sie aktuell hält. Neue Anbieter: Import hier, Eintrag in go.mod
// (`go get …` + `go mod tidy`), Snippet `tls-dns-<name>` in compose.yaml und Liste in apps/installer/src/dns.ts.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "github.com/caddyserver/caddy/v2/modules/standard"

	_ "github.com/caddy-dns/cloudflare"
	_ "github.com/caddy-dns/desec"
	_ "github.com/caddy-dns/hetzner/v2"
	_ "github.com/caddy-dns/inwx"
	_ "github.com/caddy-dns/ionos"
	_ "github.com/caddy-dns/netcup"
	_ "github.com/caddy-dns/rfc2136"
	_ "github.com/caddy-dns/route53"
)

func main() {
	caddycmd.Main()
}
