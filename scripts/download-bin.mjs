// scripts/download.js
import https from 'https'
import fs, { mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import unzipper from 'unzipper'
import * as tar from 'tar'
import { copySync } from 'cpx'

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url} to ${dest}`)
    https
      .get(url, (response) => {
        console.log(`Response status code: ${response.statusCode}`)
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          // Handle redirect
          const redirectURL = response.headers.location
          console.log(`Redirecting to ${redirectURL}`)
          response.resume()
          download(redirectURL, dest).then(resolve, reject) // Recursive call
          return
        } else if (response.statusCode !== 200) {
          response.resume()
          reject(`Failed to get '${url}' (${response.statusCode})`)
          return
        }
        const file = fs.createWriteStream(dest)
        response.pipe(file)
        file.on('finish', () => {
          file.close(resolve)
        })
        file.on('error', (err) => {
          fs.unlink(dest, () => reject(err.message))
        })
      })
      .on('error', (err) => {
        fs.unlink(dest, () => reject(err.message))
      })
  })
}

async function decompress(filePath, targetDir) {
  console.log(`Decompressing ${filePath} to ${targetDir}`)
  if (filePath.endsWith('.zip')) {
    await fs
      .createReadStream(filePath)
      .pipe(unzipper.Extract({ path: targetDir }))
      .promise()
  } else if (filePath.endsWith('.tar.gz')) {
    await tar.x({
      file: filePath,
      cwd: targetDir,
    })
  } else {
    throw new Error(`Unsupported archive format: ${filePath}`)
  }
}

async function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url)
    opts.headers = {
      'User-Agent': 'jan-app',
      'Accept': 'application/vnd.github+json',
      ...headers,
    }
    https
      .get(opts, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return getJson(res.headers.location, headers).then(resolve, reject)
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} failed with status ${res.statusCode}`))
          return
        }
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

function matchSqliteVecAsset(assets, platform, arch) {
  const osHints =
    platform === 'darwin'
      ? ['darwin', 'macos', 'apple-darwin']
      : platform === 'win32'
        ? ['windows', 'win', 'msvc']
        : ['linux']

  const archHints = arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'x64', 'amd64']
  // The fallbacks below drop the arch hint: windows-arm64 has no sqlite-vec
  // build and would take the x86_64 dll, which cannot load. Skipping is the
  // supported outcome -- the caller falls back to linear search.
  const foreignArchHints =
    arch === 'arm64'
      ? ['x86_64', 'x64', 'amd64', 'i686']
      : ['arm64', 'aarch64', 'armv7']
  const extHints = ['zip', 'tar.gz']

  const lc = (s) => s.toLowerCase()
  const candidates = assets
    .filter((a) => a && a.browser_download_url && a.name)
    .map((a) => ({ name: lc(a.name), url: a.browser_download_url }))
    .filter((c) => !foreignArchHints.some((h) => c.name.includes(h)))

  // Prefer exact OS + arch matches
  let matches = candidates.filter((c) => osHints.some((o) => c.name.includes(o)) && archHints.some((h) => c.name.includes(h)) && extHints.some((e) => c.name.endsWith(e)))
  if (matches.length) return matches[0].url
  // OS only. Safe: foreign arches are filtered above, so this relaxes the arch
  // spelling, not the arch.
  matches = candidates.filter((c) => osHints.some((o) => c.name.includes(o)) && extHints.some((e) => c.name.endsWith(e)))
  if (matches.length) return matches[0].url
  // No last resort: it would fire only when nothing matches this OS, so any
  // archive it picked would be for another platform.
  return null
}

async function fetchLatestSqliteVecUrl(platform, arch) {
  try {
    const rel = await getJson('https://api.github.com/repos/asg017/sqlite-vec/releases/latest')
    const url = matchSqliteVecAsset(rel.assets || [], platform, arch)
    return url
  } catch (e) {
    console.log('Failed to query sqlite-vec latest release:', e.message)
    return null
  }
}

function getPlatformArch() {
  const platform = os.platform() // 'darwin', 'linux', 'win32'
  const arch = os.arch() // 'x64', 'arm64', etc.

  let bunPlatform, uvPlatform

  if (platform === 'darwin') {
    bunPlatform = arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x64'
    uvPlatform =
      arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  } else if (platform === 'linux') {
    bunPlatform = arch === 'arm64' ? 'linux-aarch64' : 'linux-x64'
    uvPlatform =
      arch === 'arm64'
        ? 'aarch64-unknown-linux-gnu'
        : 'x86_64-unknown-linux-gnu'
  } else if (platform === 'win32') {
    bunPlatform = arch === 'arm64' ? 'windows-aarch64' : 'windows-x64'
    uvPlatform =
      arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : 'x86_64-pc-windows-msvc'
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }

  return { bunPlatform, uvPlatform }
}

async function main() {
  if (process.env.SKIP_BINARIES) {
    console.log('Skipping binaries download.')
    process.exit(0)
  }
  console.log('Starting main function')
  const platform = os.platform()
  const { bunPlatform, uvPlatform } = getPlatformArch()
  console.log(`bunPlatform: ${bunPlatform}, uvPlatform: ${uvPlatform}`)

  const binDir = 'src-tauri/resources/bin'
  const tempBinDir = 'scripts/dist'
  const bunPath = `${tempBinDir}/bun-${bunPlatform}.zip`
  let uvPath = `${tempBinDir}/uv-${uvPlatform}.tar.gz`
  if (platform === 'win32') {
    uvPath = `${tempBinDir}/uv-${uvPlatform}.zip`
  }
  mkdirSync(tempBinDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  // Adjust these URLs based on latest releases
  const bunUrl = `https://github.com/oven-sh/bun/releases/latest/download/bun-${bunPlatform}.zip`

  let uvUrl = `https://github.com/astral-sh/uv/releases/latest/download/uv-${uvPlatform}.tar.gz`
  if (platform === 'win32') {
    uvUrl = `https://github.com/astral-sh/uv/releases/latest/download/uv-${uvPlatform}.zip`
  }

  console.log(`Downloading Bun for ${bunPlatform}...`)
  const bunSaveDir = path.join(tempBinDir, `bun-${bunPlatform}.zip`)
  if (!fs.existsSync(bunSaveDir)) {
    await download(bunUrl, bunSaveDir)
    await decompress(bunPath, tempBinDir)
  }
  if (platform === 'win32') {
    copySync(
      path.join(tempBinDir, `bun-${bunPlatform}`, 'bun.exe'),
      path.join(binDir)
    )
    // uvPlatform, not bunPlatform: tauri names externalBin by rust target
    // triple, which is uv's spelling and not bun's.
    fs.copyFileSync(
      path.join(binDir, 'bun.exe'),
      path.join(binDir, `bun-${uvPlatform}.exe`)
    )
  } else {
    copySync(
      path.join(tempBinDir, `bun-${bunPlatform}`, 'bun'),
      path.join(binDir)
    )
    const bunBin = path.join(binDir, 'bun')
    fs.chmodSync(bunBin, 0o755)
    if (platform === 'darwin') {
      for (const target of [
        'bun-x86_64-apple-darwin',
        'bun-aarch64-apple-darwin',
        'bun-universal-apple-darwin',
      ]) {
        const dest = path.join(binDir, target)
        fs.copyFileSync(bunBin, dest)
        fs.chmodSync(dest, 0o755)
      }
    } else if (platform === 'linux') {
      // uvPlatform, not bunPlatform: tauri names externalBin by rust target
      // triple, which is uv's spelling and not bun's.
      const dest = path.join(binDir, `bun-${uvPlatform}`)
      fs.copyFileSync(bunBin, dest)
      fs.chmodSync(dest, 0o755)
    }
  }
  console.log('Bun downloaded.')

  console.log(`Downloading UV for ${uvPlatform}...`)
  const uvExt = platform === 'win32' ? `zip` : `tar.gz`
  const uvSaveDir = path.join(tempBinDir, `uv-${uvPlatform}.${uvExt}`)
  if (!fs.existsSync(uvSaveDir)) {
    await download(uvUrl, uvSaveDir)
    await decompress(uvPath, tempBinDir)
  }
  if (platform === 'win32') {
    copySync(path.join(tempBinDir, 'uv.exe'), path.join(binDir))
    fs.copyFileSync(
      path.join(binDir, 'uv.exe'),
      path.join(binDir, `uv-${uvPlatform}.exe`)
    )
  } else {
    copySync(path.join(tempBinDir, `uv-${uvPlatform}`, 'uv'), path.join(binDir))
    const uvBin = path.join(binDir, 'uv')
    fs.chmodSync(uvBin, 0o755)
    if (platform === 'darwin') {
      for (const target of [
        'uv-x86_64-apple-darwin',
        'uv-aarch64-apple-darwin',
        'uv-universal-apple-darwin',
      ]) {
        const dest = path.join(binDir, target)
        fs.copyFileSync(uvBin, dest)
        fs.chmodSync(dest, 0o755)
      }
    } else if (platform === 'linux') {
      const dest = path.join(binDir, `uv-${uvPlatform}`)
      fs.copyFileSync(uvBin, dest)
      fs.chmodSync(dest, 0o755)
    }
  }
  console.log('UV downloaded.')

  // ----- sqlite-vec (optional, ANN acceleration) -----
  try {
    const binDir = 'src-tauri/resources/bin'
    const platform = os.platform()
    const ext = platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so'
    const targetLibPath = path.join(binDir, `sqlite-vec.${ext}`)

    if (fs.existsSync(targetLibPath)) {
      console.log(`sqlite-vec already present at ${targetLibPath}`)
    } else {
      let sqlvecUrl = await fetchLatestSqliteVecUrl(platform, os.arch())
      // Allow override via env if needed
      if ((process.env.SQLVEC_URL || process.env.JAN_SQLITE_VEC_URL) && !sqlvecUrl) {
        sqlvecUrl = process.env.SQLVEC_URL || process.env.JAN_SQLITE_VEC_URL
      }
      if (!sqlvecUrl) {
        console.log('Could not determine sqlite-vec download URL; skipping (linear fallback will be used).')
      } else {
        console.log(`Downloading sqlite-vec from ${sqlvecUrl}...`)
        const sqlvecArchive = path.join(tempBinDir, `sqlite-vec-download`)
        const guessedExt = sqlvecUrl.endsWith('.zip') ? '.zip' : sqlvecUrl.endsWith('.tar.gz') ? '.tar.gz' : ''
        const archivePath = sqlvecArchive + guessedExt
        await download(sqlvecUrl, archivePath)
        if (!guessedExt) {
          console.log('Unknown archive type for sqlite-vec; expecting .zip or .tar.gz')
        } else {
          await decompress(archivePath, tempBinDir)
          // Try to find a shared library in the extracted files
          const candidates = []
          function walk(dir) {
            for (const entry of fs.readdirSync(dir)) {
              const full = path.join(dir, entry)
              const stat = fs.statSync(full)
              if (stat.isDirectory()) walk(full)
              else if (full.endsWith(`.${ext}`)) candidates.push(full)
            }
          }
          walk(tempBinDir)
          if (candidates.length === 0) {
            console.log('No sqlite-vec shared library found in archive; skipping copy.')
          } else {
            // Pick the first match and copy/rename to sqlite-vec.<ext>
            const libSrc = candidates[0]
            // Ensure we copy the FILE, not a directory (fs-extra copySync can copy dirs)
            if (fs.statSync(libSrc).isFile()) {
              fs.copyFileSync(libSrc, targetLibPath)
              console.log(`sqlite-vec installed at ${targetLibPath}`)
            } else {
              console.log(`Found non-file at ${libSrc}; skipping.`)
            }
          }
        }
      }
    }
  } catch (err) {
    console.log('sqlite-vec download step failed (non-fatal):', err)
  }

  console.log('Downloads completed.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
