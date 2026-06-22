# TLS certificates

Provide your certificate here so nginx can serve HTTPS on :443:

```
nginx/certs/tls.crt   # server cert + intermediate chain (k8s-style)
nginx/certs/tls.key   # private key (PEM)
```

- Both files are git-ignored (only this README and `.gitkeep` are tracked) — keys never land in git.
- nginx mounts this folder read-only at `/etc/nginx/certs` and reads exactly those two filenames.
- **Required:** nginx will not start until both files are present. There is no self-signed fallback.

If your provider gives a separate cert + chain, concatenate them into tls.crt:

```
cat cert.pem chain.pem > tls.crt
```
