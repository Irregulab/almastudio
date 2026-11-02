# almastudio.irregulab.com

The website of AlmaStudio and the AlmaStudio Companion App: the landing page,
the companion app page, and the pages the stores ask for (privacy policy, data
deletion, support, terms).

A Next.js app exported as plain static files (`output: 'export'`): no server,
no cookies, no analytics.

## Develop

```sh
npm install
npm run dev        # http://localhost:3000
npm run typecheck
```

Every outside link (GitHub, releases, App Store, Google Play, contact email)
and the date of the legal pages live in `src/config.ts`. The companion app is
available on the App Store for iPhone and iPad, and on Google Play for Android.

## Build

```sh
npm run build      # writes the site to out/
npm start          # serves out/ locally to check it
```

## Deploy

Copy `out/` to any static host and point `almastudio.irregulab.com` at it.
URLs end with a slash (`trailingSlash: true`), so each page is a folder with
an `index.html`; the host must serve `index.html` for a folder and `404.html`
for a missing page.

Store listings link to:

- Privacy policy: https://almastudio.irregulab.com/privacy/
- Data deletion: https://almastudio.irregulab.com/delete-data/
- Support: https://almastudio.irregulab.com/support/
- Marketing: https://almastudio.irregulab.com/companion/
