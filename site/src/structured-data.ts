// Schema.org data for search engines, rendered as JSON-LD by <JsonLd>.

import { site } from '@/config'

const organization = {
  '@type': 'Organization',
  '@id': `${site.url}/#organization`,
  name: site.company,
  brand: { '@type': 'Brand', name: site.studio },
  email: site.email,
  url: site.url,
  logo: `${site.url}/icon-512.png`,
  sameAs: [site.github],
}

const free = { '@type': 'Offer', price: '0', priceCurrency: 'EUR' }

/** Who publishes the site and the apps, and the site itself. */
export const siteGraph = {
  '@context': 'https://schema.org',
  '@graph': [
    organization,
    {
      '@type': 'WebSite',
      '@id': `${site.url}/#website`,
      name: site.name,
      url: `${site.url}/`,
      inLanguage: 'en',
      publisher: { '@id': organization['@id'] },
    },
  ],
}

/** The desktop app, on the home page. */
export const desktopApp = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  '@id': `${site.url}/#desktop`,
  name: site.name,
  description:
    'A desktop workspace for AI coding agents: Claude Code, Codex, OpenCode and shells side by side, project by project, with git, files and diffs one click away.',
  url: `${site.url}/`,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Windows, Linux',
  downloadUrl: site.releases,
  screenshot: `${site.url}/main-window.png`,
  image: `${site.url}/icon-512.png`,
  license: site.license,
  isAccessibleForFree: true,
  offers: free,
  publisher: { '@id': organization['@id'] },
}

const stores = [site.googlePlay, site.appStore]

/** The companion app, on its own page. */
export const companionApp = {
  '@context': 'https://schema.org',
  '@type': 'MobileApplication',
  '@id': `${site.url}/companion/#app`,
  name: 'AlmaStudio Companion App',
  description:
    'Watch and drive the terminals and AI agents running in AlmaStudio on your computer from an iPhone, iPad or Android device, end-to-end encrypted.',
  url: `${site.url}/companion/`,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Android, iOS, iPadOS',
  installUrl: stores[0],
  sameAs: stores,
  image: `${site.url}/icon-512.png`,
  isAccessibleForFree: true,
  offers: free,
  publisher: { '@id': organization['@id'] },
  isRelatedTo: { '@id': `${site.url}/#desktop` },
}
