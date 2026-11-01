# Settings

Pinnery is configured with environment variables, set in your `compose.yaml` (see the [README](../README.md#getting-started)).

| Setting | Required | What it does |
| --- | --- | --- |
| `PINNERY_ADMIN_EMAIL` | yes | Email of the first (admin) account. |
| `PINNERY_PASSWORD` | yes | First sign-in password for that account. Forgotten the admin password? Change this value and restart to reset it. |
| `PINNERY_PUBLIC_URL` | recommended | The address people use to reach Pinnery, e.g. `https://pinnery.example.com`. Used in emailed links. "Forgot password" only emails reset links when this is set; without it, an admin can hand out reset links instead. |
| `PINNERY_SMTP_HOST` | for email | Your mail server, e.g. `smtp.example.com`. |
| `PINNERY_SMTP_PORT` | | Default `587` (`465` when `PINNERY_SMTP_SECURE` is `true`). |
| `PINNERY_SMTP_SECURE` | | `true` for a TLS connection from the start (usually port 465). Defaults to on when the port is `465`, off otherwise. |
| `PINNERY_SMTP_USER`, `PINNERY_SMTP_PASSWORD` | | Your mail login, if it needs one. |
| `PINNERY_SMTP_FROM` | for email | The sender, e.g. `Pinnery <pinnery@example.com>`. Email is only on when this and `PINNERY_SMTP_HOST` are both set. |
| `PINNERY_FETCH_ALLOW` | | Lets Pinnery save images from addresses on your own network (blocked by default). A comma-separated list of addresses or ranges, e.g. `192.168.1.0/24,10.0.0.5`. |
| `PINNERY_PROXIES` | | How many reverse proxies sit in front of Pinnery. Default `1`. Set `0` if there's none. See [Proxies and sign-in limits](proxies.md). |
| `TZ` | | Your time zone. |
| `PORT` | | The port Pinnery listens on inside the container. Default `3420`. |
| `DATA_DIR` | | Where Pinnery keeps its data inside the container. Default `/data`, which the image declares as a volume. |

Email is optional; see [Email](email.md). For `PINNERY_PROXIES`, see [Proxies and sign-in limits](proxies.md).
