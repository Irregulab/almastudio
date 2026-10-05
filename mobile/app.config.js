// app.json holds the config; this only adds what cannot live in the repo.
// Android push needs Firebase's google-services.json: EAS builds get it from
// the GOOGLE_SERVICES_JSON file variable, local builds from a copy next to
// this file (ignored by git). Without either the app builds, minus push.
const fs = require('fs')
const path = require('path')

module.exports = ({ config }) => {
  const local = path.join(__dirname, 'google-services.json')
  const file = process.env.GOOGLE_SERVICES_JSON ?? (fs.existsSync(local) ? local : undefined)
  return file ? { ...config, android: { ...config.android, googleServicesFile: file } } : config
}
