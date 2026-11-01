# Email

Email is optional. Without it, invite and password-reset links are shown on screen for you to pass on yourself. The one thing that needs email is changing your own sign-in address (Settings → Account), because the new address has to be confirmed.

With email set up, Pinnery sends:

- **Invites:** a sign-up link, valid for 24 hours.
- **Password resets:** from "Forgot password?" on the sign-in page, a link valid for an hour. These are only emailed when `PINNERY_PUBLIC_URL` is set, so the link can't be pointed somewhere else. Without it, an admin can still hand out a reset link from Settings → Users.
- **Email changes:** a confirmation link to the new address, valid for 24 hours. Once it's confirmed, the old address gets a notice and any reset links sent to it stop working.

## Setting it up

Add these to your `compose.yaml`:

```yaml
      PINNERY_PUBLIC_URL: https://pinnery.example.com
      PINNERY_SMTP_HOST: smtp.example.com
      PINNERY_SMTP_PORT: 587
      PINNERY_SMTP_USER: pinnery@example.com
      PINNERY_SMTP_PASSWORD: your-mail-password
      PINNERY_SMTP_FROM: Pinnery <pinnery@example.com>
```

Email is on when both `PINNERY_SMTP_HOST` and `PINNERY_SMTP_FROM` are set. If your provider uses port 465, set `PINNERY_SMTP_PORT: 465`; Pinnery then connects over TLS from the start. Every setting is described in [Settings](settings.md).
