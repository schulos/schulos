# Test-Zertifikate (nur für Tests)

Erzeugt mit openssl (P-256, 100 Jahre gültig). `ca.pem` hat `localhost.pem` (localhost, 127.0.0.1) signiert; `other-ca.pem` ist eine
fremde CA für Negativtests. Der Schlüssel `localhost.key` ist absichtlich öffentlich – nie für etwas anderes als Tests verwenden.

`cosign-test.pub`, `release.json`, `release.json.sig`: Test-Schlüsselpaar aus `cosign generate-key-pair` (cosign v3.0.2, Passwort `test`,
privater Schlüssel verworfen) und damit per `cosign sign-blob --use-signing-config=false --tlog-upload=false` signiertes Beispiel-Manifest.
Prüft, dass `verifyManifestSignature()` echte cosign-Signaturen versteht. `release.json` ist byte-genau signiert (`.gitattributes: -text`).
