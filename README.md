# Pinnery

Your own private Pinterest. Save images from anywhere into boards, browse them in a tidy grid, and share boards with the people you choose. It runs on your own server, so your pins stay yours.

- **Boards** with cover images, a masonry grid and a full-screen viewer
- **Save from anywhere**: a Chrome extension (right-click any image), your phone's share menu, or drag, drop, paste and upload in the app
- **Share boards** with family or friends, as viewers or editors
- **Accounts by invite only**: nobody can sign up uninvited
- **Export and import** your boards as a zip at any time
- Light and dark mode, a choice of accent colours, works on desktop and phone

## Getting started

You'll need Docker. Create a `compose.yaml`:

```yaml
services:
  pinnery:
    image: ghcr.io/danjam/pinnery:latest
    restart: unless-stopped
    environment:
      # The first (admin) account. The password only gets you in the first time:
      # you'll be asked to choose a new one when you sign in.
      PINNERY_ADMIN_EMAIL: you@example.com
      PINNERY_PASSWORD: change-me

      # The address people use to reach Pinnery. Used in emailed links.
      PINNERY_PUBLIC_URL: https://pinnery.example.com

      # Email (optional). Leave these out and invite / password-reset links
      # are shown on screen instead.
      PINNERY_SMTP_HOST: smtp.example.com
      PINNERY_SMTP_PORT: 587             # default 587
      # PINNERY_SMTP_SECURE: "true"      # if your provider uses port 465
      PINNERY_SMTP_USER: pinnery@example.com
      PINNERY_SMTP_PASSWORD: your-mail-password
      PINNERY_SMTP_FROM: Pinnery <pinnery@example.com>

      # Optional: let Pinnery save images from addresses on your own network
      # (blocked by default).
      # PINNERY_FETCH_ALLOW: 192.168.1.0/24

      # How many reverse proxies sit in front of Pinnery. 1 (the default)
      # suits one proxy such as Traefik or Caddy. Use 0 if there's none.
      # PINNERY_PROXIES: 1

      TZ: Europe/London
    volumes:
      - ./data:/data                     # your images and database
    ports:
      - "3420:3420"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3420/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

The container runs as user id 1000, so create the data folder with that owner first: `mkdir data && sudo chown 1000:1000 data`.

Pinnery is meant to sit behind a reverse proxy with HTTPS (Caddy, Traefik, Nginx Proxy Manager…). Sign-in, the phone app and the extension all expect it. Once that's set up, start Pinnery with `docker compose up -d`, open your Pinnery address, and sign in with that email and password. You'll be asked to choose a new password straight away. The one in the file is only used to get you in the first time.

Just trying it out? `http://your-server:3420` works too. If people use Pinnery that way for real, with no proxy in front, set `PINNERY_PROXIES: 0` (see below).

### Proxies and sign-in limits

After 10 wrong passwords from one address, Pinnery blocks that address for up to 15 minutes. Behind a proxy, every visitor seems to come from the proxy, so Pinnery reads the visitor's real address from the `X-Forwarded-For` header the proxy adds. That header is a list: anyone can put addresses at the start, and each proxy adds the address it saw to the end. `PINNERY_PROXIES` tells Pinnery how many entries from the end to read.

- **One proxy (Traefik, Caddy, Nginx Proxy Manager…):** leave it at the default, `1`.
- **Two proxies (e.g. Cloudflare, then Traefik):** `2`.
- **No proxy:** `0`. If you leave it at `1` with no proxy, anyone can claim any address and get round the limit.

Pinnery also uses the proxy's `X-Forwarded-Proto` header to tell when visitors are on HTTPS, so it can mark the sign-in cookie secure.

## Settings

| Setting | Required | What it does |
| --- | --- | --- |
| `PINNERY_ADMIN_EMAIL` | yes | Email of the first (admin) account. |
| `PINNERY_PASSWORD` | yes | First sign-in password for that account. Forgotten the admin password? Change this value and restart to reset it. |
| `PINNERY_PUBLIC_URL` | recommended | The address people use to reach Pinnery, e.g. `https://pinnery.example.com`. Used in emailed links. |
| `PINNERY_SMTP_HOST` | for email | Your mail server, e.g. `smtp.example.com`. |
| `PINNERY_SMTP_PORT` | | Default `587`. |
| `PINNERY_SMTP_SECURE` | | Set to `true` if your provider uses port 465. |
| `PINNERY_SMTP_USER`, `PINNERY_SMTP_PASSWORD` | | Your mail login, if it needs one. |
| `PINNERY_SMTP_FROM` | for email | The sender, e.g. `Pinnery <pinnery@example.com>`. |
| `PINNERY_FETCH_ALLOW` | | Lets Pinnery save images from addresses on your own network (blocked by default), e.g. `192.168.1.0/24`. |
| `PINNERY_PROXIES` | | How many reverse proxies sit in front of Pinnery. Default `1`. Set `0` if there's none. See [Proxies and sign-in limits](#proxies-and-sign-in-limits). |
| `TZ` | | Your time zone. |

Email is optional. Without it, everything still works: invite and password-reset links are shown on screen for you to pass on yourself.

## Inviting people and sharing boards

- **Invite someone**: Settings → Users → Invite someone. They get a sign-up link, valid for 24 hours, and choose their own name and password.
- **Share a board**: open the board's ⋯ menu → Share… and pick a person.
  - **Viewer**: can see the board and its pins.
  - **Editor**: can also add pins to it and remove them.
  - Shared boards show on their home page, marked with who shared them.
- **Forgotten password**: use "Forgot password?" on the sign-in page (needs email), or an admin can send a reset link from Settings → Users.
- **Admins** can make other people admins, reset passwords and remove accounts. Removing someone also removes their boards.

## Chrome extension

1. In Pinnery, go to Settings → Devices and download the extension.
2. Unzip it somewhere permanent. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the unzipped folder.
3. Open the extension's options, enter your Pinnery address, and click **Connect**. Sign in if asked, then allow it.
4. Right-click any image on the web → **Pin to Pinnery** → pick a board → **Pin**.

It also works in other Chromium browsers such as Edge and Brave. When a newer version of the extension is available, its options page will tell you.

## On your phone (Android)

1. Open Pinnery in Chrome (over HTTPS; Chrome won't install it from a plain http address) and go to Settings → Devices → **Install app**.
2. To save an image, download it on your phone, then share it from your gallery → **Pinnery** → pick a board.

## Your data

Everything lives in the `data` folder: your images and a database file. To back it up, stop Pinnery first (`docker compose stop`), copy the folder, then start it again. Copying it while it's running can give a broken database. Export from Settings → Import/Export gives you a zip of your boards that you can import into any Pinnery.

## Updating

Pull the new image and restart: `docker compose pull && docker compose up -d`. Your data is upgraded automatically, and a backup is made first when needed.

## Licence

MIT. Icons from [Material Design Icons](https://pictogrammers.com/library/mdi/) (Apache-2.0); see [NOTICE](NOTICE).
