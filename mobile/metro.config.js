// The app shares the protocol with the desktop through ../packages/protocol,
// which sits outside this project and is not an npm workspace, so Metro is
// told to watch it and to look in this project's node_modules first. The
// protocol imports nothing but @noble, so no second React can come in.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [
  path.resolve(repoRoot, 'packages/protocol'),
  path.resolve(repoRoot, 'packages/shared'),
]
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')]
config.resolver.extraNodeModules = {
  '@almastudio/protocol': path.resolve(repoRoot, 'packages/protocol'),
  '@almastudio/shared': path.resolve(repoRoot, 'packages/shared'),
}

module.exports = config
