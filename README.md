Site located at: https://kiwamasi.github.io/Besaid-Island/

## Shared backlog and accounts

The website stays on GitHub Pages. A Netlify Function and Netlify Blobs power the shared backlog and account store. Anyone can view the same list and create a view-only account. Only the reserved `Kiwamari` account can add or remove games.

Set these environment variables in Netlify project settings and redeploy the function:

- `BACKLOG_PASSWORD`: the non-empty password for `Kiwamari`. Netlify stores this server-side; never commit it.
- `SESSION_SECRET`: a separate random secret used to sign login tokens. Keep it private and at least 32 characters.
- `ALLOWED_ORIGIN`: optional; defaults to `https://kiwamasi.github.io`.

New non-owner accounts are stored in Netlify Blobs with salted scrypt password hashes. Passwords can be any non-empty value up to 128 characters. Their credentials are never returned by the API. The browser keeps a signed token in local storage, so accounts remain signed in across browser restarts. Tokens have no time-based expiry. Signing out clears the token from that browser; changing `SESSION_SECRET` invalidates all issued tokens. Changing `BACKLOG_PASSWORD` alone does not invalidate an existing owner token. Netlify plan limits apply.
