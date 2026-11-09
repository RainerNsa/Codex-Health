# The browser preview on Vercel

A link sponsors can open without a password, an account or a server. The preview is the real app running entirely
in the visitor's browser: the unchanged web app (`apps/web`), the real API routes (`apps/api/src/routes.ts`) and the
real database migrations, with row-level security and the audit chain, on an in-memory Postgres (PGlite) built when
the page opens. Synthetic data only.

| | Browser preview (this page) | AWS demo (`docs/deploy-demo.md`) |
| --- | --- | --- |
| Where it runs | The visitor's browser; Vercel serves static files | One server in AWS |
| Data | Made up, per visitor, gone on reload | Made up, shared by everyone with the password |
| Reading documents (Textract, Bedrock) | Off: uploads answer "Document storage is not configured" | On |
| Access | Anyone with the link (not indexed by search engines) | Password gate |
| Cost | Free hosting tier, or Vercel Pro (see below) | About $20 a month plus a domain |

## What a visitor sees

A banner on every page: the preview runs in your browser with made-up data, nothing leaves the page, reloading starts
over, and do not enter real patient information. The site opens first; **Sign in** opens the app, where they pick a
ZZTEST user. The five demo stories from `docs/deploy-demo.md` are in the queue at ZZTEST Alpha Facility 1 (the same
seed, `scripts/dev/seed-core.mjs`). The first load downloads about 4 MB (the database engine); after that it starts
in a second or two.

## Deploy (a person does this; agents never create hosting accounts or projects)

1. Sign in at vercel.com with GitHub and choose **Add New → Project**, then import `RainerNsa/Codex-Health`.
2. Leave **Root Directory** at the repository root and **Framework Preset** at Other. `vercel.json` sets the install
   and build commands, the output folder and the security headers; change nothing else.
3. **Deploy**. The link is `https://<project>.vercel.app`. Every merge to `main` redeploys it.

Vercel's free Hobby plan is for personal, non-commercial use under its terms; showing the product to sponsors is
company use, so check the current terms and use the Pro plan if they require it. The build is plain static files, so
any static host works if that is a problem (its security headers would need setting to match `vercel.json`).

## Check it locally first

```sh
npm run build -w @codex-health/preview
cd apps/preview && npx playwright test     # serves the build with vercel.json's headers and clicks through it
```

## Limits

- No document reading, page images or evidence quotes from documents: those need AWS. Facts are entered by hand.
- Each visitor has their own copy; nothing they do is seen by anyone else, or kept.
- It is not the product deployment: no real sign-in, and no real data ever, which is why it stores nothing.
