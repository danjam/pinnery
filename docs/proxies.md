# Proxies and sign-in limits

After 10 wrong passwords from one address, Pinnery blocks that address for up to 15 minutes. Behind a proxy, every visitor seems to come from the proxy, so Pinnery reads the visitor's real address from the `X-Forwarded-For` header the proxy adds. That header is a list: anyone can put addresses at the start, and each proxy adds the address it saw to the end. `PINNERY_PROXIES` tells Pinnery how many entries from the end to read.

- **One proxy (Traefik, Caddy, Nginx Proxy Manager…):** leave it at the default, `1`.
- **Two proxies (e.g. Cloudflare, then Traefik):** `2`.
- **No proxy:** `0`. If you leave it at `1` with no proxy, anyone can claim any address and get round the limit.

Pinnery also uses the proxy's `X-Forwarded-Proto` header to tell when visitors are on HTTPS, so it can mark the sign-in cookie secure.
