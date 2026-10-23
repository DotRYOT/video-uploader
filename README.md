# Video Drop

A small, password-gated video uploader built for Cloudflare Workers and R2. Anyone with the shared password can upload; share links are public to anyone who has the URL and expire automatically.

## Limits

Edit [src/config.ts](src/config.ts) to change the upload cap, accepted video formats, or tier limits. The defaults allow five active 1-day videos, three active 7-day videos, and two active 30-day videos. Expired videos are deleted from R2 by the 15-minute scheduled cleanup. The default upload cap is 95 MiB, leaving room under a 100 MB Worker request-body limit.

The tier limits are active-link slots, not lifetime upload counts. A slot becomes available when its video expires.

## Cloudflare setup

1. Install Node.js and npm, then run `npm install`.
2. Make sure the `video-server` R2 bucket exists in the Cloudflare account that will deploy this Worker. The Worker accesses it through the `VIDEOS_BUCKET` binding in [wrangler.jsonc](wrangler.jsonc).
3. Set the shared upload password and a separate, long random session-signing secret:

	```sh
	npx wrangler secret put UPLOAD_PASSWORD
	npx wrangler secret put SESSION_SECRET
	```

4. Run `npm run dev` for local development or `npm run deploy` to deploy. Apply the Durable Object migration on the first deployment; Wrangler prompts for this when needed.
5. For local development, copy `.env.example` to `.dev.vars`, replace both placeholder values, and run `npm run dev`. Wrangler reads `.dev.vars`; it does not load `.env.example` directly. Both files are excluded from git except the example template.
6. Add a Cloudflare rate-limiting rule for `POST /api/login` before sharing the uploader publicly.

## Share pages

Each `/v/<id>` page has Open Graph video fields, Twitter player fields, a share title and description, and a JPEG preview when the uploader's browser can decode the video. Videos are served with byte-range support for seeking. Links are intentionally public and should be treated as unlisted, not access-controlled.