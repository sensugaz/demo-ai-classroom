# TLS certificates

Drop your certificate here so nginx can serve HTTPS on :443:

```
nginx/certs/tls.crt   # server cert + intermediate chain (k8s-style)
nginx/certs/tls.key   # private key (PEM)
```

- Both files are git-ignored (only this README and `.gitkeep` are tracked) — keys never land in git.
- nginx mounts this folder at `/etc/nginx/certs` and reads exactly those two filenames.
- If the folder is empty on first `docker compose up`, a throwaway **self-signed**
  cert is generated so nginx still boots (browsers will warn). Replace it with
  your real cert and restart: `docker compose restart nginx`.

If your provider gives a separate cert + chain, concatenate them into tls.crt:

```
cat cert.pem chain.pem > tls.crt
```
