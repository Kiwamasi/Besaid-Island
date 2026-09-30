Site located at: https://kiwamasi.github.io/Besaid-Island/

## Shared backlog API

The backlog page uses a public Netlify Function with Netlify Blobs storage. GitHub Pages remains the website host.

1. Connect this repository to Netlify and deploy the main branch. Netlify reads `netlify.toml` to deploy the function.
2. Copy the site's `netlify.app` URL and set `window.BACKLOG_API_URL` in `backlog-config.js` to `https://<site-name>.netlify.app/.netlify/functions/backlog`.
3. Commit and push that URL change so GitHub Pages can call the function.

The API has no login: anyone can view, add, or remove backlog entries. Do not put private information in it. Netlify plan limits apply.
