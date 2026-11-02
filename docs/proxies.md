# Proxies and sign-in limits

After 10 wrong passwords from one address, Pinnery blocks that address for up to 15 minutes. Behind a proxy, every visitor seems to come from the proxy, so Pinnery reads the visitor's real address from the `X-Forwarded-For` header the proxy adds. That header is a list: anyone can put addresses at the start, and each proxy adds the address it saw to the end. `PINNERY_PROXIES` tells Pinnery how many entries from the end to read.

- **One proxy (Traefik, Caddy, Nginx Proxy Manager…):** leave it at the default, `1`.
- **Two proxies (e.g. Cloudflare, then Traefik):** `2`.
- **No proxy:** `0`. If you leave it at `1` with no proxy, anyone can claim any address and get round the limit.

The same address is used for a general cap of 1000 requests a minute, far above normal use.

Pinnery also uses the proxy's `X-Forwarded-Proto` header to tell when visitors are on HTTPS, so it can mark the sign-in cookie secure.

## Behind a proxy, don't publish the port

With `PINNERY_PROXIES` above `0`, Pinnery trusts the last entries of `X-Forwarded-For` because it expects only the proxy to reach it. If the port is also published (`3420:3420` in the compose file), anyone who can reach that port can skip the proxy, send their own `X-Forwarded-For`, and pick a new address for every guess: the sign-in limit no longer applies to them.

So when a proxy is in front, make the proxy the only way in:

- **Proxy in Docker:** remove the `ports:` lines and put Pinnery on the proxy's Docker network.
- **Proxy on the same machine, outside Docker:** publish to localhost only, `127.0.0.1:3420:3420`.
- **Proxy on another machine:** firewall the port so only the proxy can reach it. Docker-published ports skip `ufw`, so filter in the `DOCKER-USER` chain instead.

## Live updates

Open pages keep a connection to `/api/events` (Server-Sent Events) so changes made elsewhere show up without a reload. Pinnery sends a heartbeat every 25 seconds and marks the stream `Cache-Control: no-transform` and `X-Accel-Buffering: no`, so Traefik, Caddy and Nginx pass it through as is. If your proxy buffers responses or times out idle ones in under 25 seconds, turn that off for `/api/events`, or pages will only catch up when they reconnect.
