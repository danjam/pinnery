# Single sign-on

Pinnery can sign people in with an OpenID Connect (OIDC) provider, such as Pocket ID, Authelia, Authentik, Keycloak or Google. The login page then shows a "Sign in with …" button next to the password form. Passwords keep working.

## Setting it up

At your provider, create an OIDC client:

- Redirect URI: `https://pinnery.example.com/auth/oidc/callback` (your `PINNERY_PUBLIC_URL` followed by `/auth/oidc/callback`)
- Scopes: `openid email profile`
- A confidential client with a secret, or a public client using PKCE

Then add to Pinnery's environment:

```yaml
      PINNERY_PUBLIC_URL: https://pinnery.example.com
      PINNERY_OIDC_ISSUER: https://id.example.com
      PINNERY_OIDC_CLIENT_ID: <client id>
      PINNERY_OIDC_CLIENT_SECRET: <client secret>
      PINNERY_OIDC_NAME: Pocket ID
```

SSO is on when the issuer, client ID and public URL are all set. Pinnery logs `oidc: SSO sign-in via …` at startup, or why it's off.

The provider must be reachable from Pinnery's container and use https. It may be on a private address: Pinnery's block on fetching from your own network applies to saved images, not to your provider.

## Who can sign in

SSO signs in existing accounts only. Accounts still come from invites, so someone your provider knows but Pinnery doesn't is turned away.

The first time someone signs in with SSO, Pinnery finds their account by email. It only does that if the provider says the email is verified, so check your provider marks it verified. From then on, the account is linked to the provider's account and found by that link, even if either email changes later. Each Pinnery account links to one provider account.

## If the provider is down

Sign in with your password. If you only ever use SSO and have forgotten it, use "Forgot password?", or for the first admin, change `PINNERY_PASSWORD` and restart (see [Settings](settings.md)).
