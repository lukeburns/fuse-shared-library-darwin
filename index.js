const fs = require('fs')
const { spawn } = require('child_process')
const path = require('path')

const OSXFUSE = path.join(__dirname, 'osxfuse')
const include = firstExistingPath([
  path.join(OSXFUSE, 'include'),
  '/usr/local/include/fuse',
  '/opt/homebrew/include/fuse',
  process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, 'include/fuse') : null
]) || path.join(OSXFUSE, 'include')
const lib = firstExistingPath([
  path.join(OSXFUSE, 'libosxfuse.dylib'),
  path.join(OSXFUSE, 'libfuse.dylib'),
  '/usr/local/lib/libosxfuse.2.dylib',
  '/usr/local/lib/libosxfuse.dylib',
  '/usr/local/lib/libfuse.2.dylib',
  '/usr/local/lib/libfuse.dylib',
  '/opt/homebrew/lib/libosxfuse.2.dylib',
  '/opt/homebrew/lib/libosxfuse.dylib',
  '/opt/homebrew/lib/libfuse.2.dylib',
  '/opt/homebrew/lib/libfuse.dylib',
  process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, 'lib/libosxfuse.2.dylib') : null,
  process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, 'lib/libosxfuse.dylib') : null,
  process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, 'lib/libfuse.2.dylib') : null,
  process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, 'lib/libfuse.dylib') : null
]) || path.join(OSXFUSE, 'libosxfuse.dylib')

const MAC_BUNDLE = '/Library/Filesystems/macfuse.fs'
const OSX_BUNDLE = '/Library/Filesystems/osxfuse.fs'
const ENV_TGZ_KEYS = ['MACFUSE_TGZ', 'OSXFUSE_TGZ']

module.exports = {
  lib,
  include,
  configure,
  unconfigure,
  isConfigured
}

function unconfigure (cb) {
  if (!cb) cb = noop
  runAll([
    [ 'rm', '-rf', MAC_BUNDLE ],
    [ 'rm', '-rf', OSX_BUNDLE ]
  ], cb)
}

function configure (cb) {
  if (!cb) cb = noop

  isConfigured(function (err, yes) {
    if (err) return cb(err)
    if (yes) return cb(null)
    const setup = getExistingBundleSetup()
    if (setup) {
      return runAll([
        [ 'chmod', '+s', setup.load ],
        function writeConfigured (next) {
          fs.writeFile(setup.configured, markerFor(), next)
        },
        [ setup.load ]
      ], cb)
    }

    const tgz = findFusetgz()
    if (!tgz) return cb(new Error(getNotFoundError()))

    const unpack = tgz.filename.includes('macfuse') ? MAC_BUNDLE : OSX_BUNDLE
    const load = path.join(unpack, 'Contents/Resources', tgz.filename.includes('macfuse') ? 'load_macfuse' : 'load_osxfuse')
    const configured = path.join(unpack, 'configured')

    runAll([
      [ 'mkdir', '-p', unpack ],
      [ 'tar', 'xzf', tgz.path, '-C', unpack ],
      [ 'chown', '-R', 'root:wheel', unpack ],
      function verifyLoader (next) {
        fs.access(load, fs.constants.X_OK, function (accessErr) {
          if (accessErr) return next(new Error('FUSE loader not found or not executable: ' + load))
          next(null)
        })
      },
      [ 'chmod', '+s', load ],
      function writeConfigured (next) {
        fs.writeFile(configured, markerFor(tgz.filename), next)
      },
      [ load ]
    ], cb)
  })
}

function isConfigured (cb) {
  const setup = getExistingBundleSetup()
  if (setup) return cb(null, true)
  for (const configured of [path.join(MAC_BUNDLE, 'configured'), path.join(OSX_BUNDLE, 'configured')]) {
    if (!fs.existsSync(configured)) continue
    try {
      const str = fs.readFileSync(configured, 'utf-8').trim()
      if (/^\d+\.\d+/.test(str)) return cb(null, true)
    } catch (err) {
      return cb(err)
    }
  }
  cb(null, false)
}

function runAll (cmds, cb) {
  loop(null)

  function loop (err) {
    if (err) return cb(err)
    if (!cmds.length) return cb(null)
    if (typeof cmds[0] === 'function') return cmds.shift()(loop)
    run(cmds.shift(), loop)
  }
}

function run (args, cb) {
  const child = spawn(args[0], args.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  let done = false

  child.stdout.on('data', function (data) {
    output += data
  })
  child.stderr.on('data', function (data) {
    output += data
  })
  child.on('error', function (err) {
    if (done) return
    done = true
    cb(err)
  })

  child.on('exit', function (code) {
    if (done) return
    done = true
    if (code) {
      const details = output.trim()
      return cb(new Error('Could not configure fuse: ' + args.join(' ') + (details ? '\n' + details : '') + '\n(exit ' + code + ')'))
    }
    cb(null)
  })
}

function getExistingBundleSetup () {
  const setups = [
    {
      bundle: MAC_BUNDLE,
      load: path.join(MAC_BUNDLE, 'Contents/Resources/load_macfuse'),
      configured: path.join(MAC_BUNDLE, 'configured')
    },
    {
      bundle: OSX_BUNDLE,
      load: path.join(OSX_BUNDLE, 'Contents/Resources/load_osxfuse'),
      configured: path.join(OSX_BUNDLE, 'configured')
    }
  ]
  for (const setup of setups) {
    if (fs.existsSync(setup.load)) return setup
  }
  return null
}

function findFusetgz () {
  for (const candidate of tgzCandidates()) {
    if (candidate.path && fs.existsSync(candidate.path)) return candidate
  }
  return null
}

function tgzCandidates () {
  const seen = new Set()
  const out = []
  const add = function (p) {
    if (!p || seen.has(p)) return
    seen.add(p)
    out.push({
      path: p,
      filename: path.basename(p)
    })
  }

  for (const key of ENV_TGZ_KEYS) {
    add(process.env[key])
  }
  add(path.join(OSXFUSE, 'osxfuse.fs.tgz'))
  add(path.join(OSXFUSE, 'macfuse.fs.tgz'))
  for (const prefix of ['/usr/local/lib', '/opt/homebrew/lib']) {
    add(path.join(prefix, 'macfuse.fs.tgz'))
    add(path.join(prefix, 'osxfuse.fs.tgz'))
  }
  if (process.env.HOMEBREW_PREFIX) {
    add(path.join(process.env.HOMEBREW_PREFIX, 'lib/macfuse.fs.tgz'))
    add(path.join(process.env.HOMEBREW_PREFIX, 'lib/osxfuse.fs.tgz'))
  }
  for (const [root, filename] of [
    ['/opt/homebrew/Caskroom/macfuse', 'macfuse.fs.tgz'],
    ['/usr/local/Caskroom/macfuse', 'macfuse.fs.tgz'],
    ['/usr/local/Caskroom/osxfuse', 'osxfuse.fs.tgz']
  ]) {
    if (!fs.existsSync(root)) continue
    try {
      for (const version of fs.readdirSync(root)) {
        add(path.join(root, version, filename))
      }
    } catch {
      // ignore
    }
  }

  return out
}

function getNotFoundError () {
  const searched = tgzCandidates().map(function (candidate) {
    return '  ' + candidate.path
  }).join('\n')
  return [
    'Could not find a FUSE tgz payload.',
    'Checked:',
    searched,
    'Install macFUSE, or set MACFUSE_TGZ/OSXFUSE_TGZ to the .tgz path and retry with sudo.'
  ].join('\n')
}

function markerFor (sourceName) {
  if (!sourceName) return 'configured-by-fuse-shared-library-darwin\n'
  return ('configured-by-fuse-shared-library-darwin:' + sourceName + '\n')
}

function firstExistingPath (paths) {
  for (const p of paths) {
    if (!p) continue
    if (fs.existsSync(p)) return p
  }
  return null
}

function noop () {}
