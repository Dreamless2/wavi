import makeWASocket, { useMultiFileAuthState, DisconnectReason, prepareWAMessageMedia } from '@whiskeysockets/baileys'
import pino from 'pino'
import { createHash, hkdfSync } from 'node:crypto'
import { createDecipheriv } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline/promises'
import AdmZip from 'adm-zip'

// ── Pack Configurations ──────────────────────────────────────────────
export const PACKS = [
  'Flump', 'Chip', 'Tuft', 'PomPom', 'Chomp',
]

const MANIFEST_URL = (id) =>
  `https://static.whatsapp.net/sticker?lottie=1&cat=sticker_pack_data&id=${id}&lg=en`

const CDN_BASE = 'https://mmg.whatsapp.net'
const UA = 'WhatsApp/2.24.6.77 A'
const OUT = 'packs'

// ── Decryption and Download Helpers ─────────────────────────────────
const fetchJSON = async (url) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

const fetchBytes = async (directPath) => {
  const r = await fetch(CDN_BASE + directPath, {
    headers: { 'User-Agent': UA },
  })
  if (!r.ok) throw new Error(`CDN ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

const decryptSticker = (encBuf, mediaKeyB64) => {
  const mediaKey = Buffer.from(mediaKeyB64, 'base64')
  const expanded = Buffer.from(
    hkdfSync('sha256', mediaKey, Buffer.alloc(0), 'WhatsApp Image Keys', 112),
  )
  const iv = expanded.subarray(0, 16)
  const cipherKey = expanded.subarray(16, 48)
  const ciphertext = encBuf.subarray(0, -10)
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

const sha256b64 = (buf) => createHash('sha256').update(buf).digest('base64')

const extractAnimationNames = (wasPath) => {
  const zip = new AdmZip(wasPath)
  const preferredEntries = [
    'animation/animation.json',
    'animation/animation_secondary.json',
  ]
  const names = []

  for (const entryName of preferredEntries) {
    const entry = zip.getEntry(entryName)
    if (!entry) continue

    const animation = JSON.parse(entry.getData().toString('utf8'))
    if (typeof animation.nm === 'string' && animation.nm.trim()) {
      names.push(animation.nm.trim())
    }
  }

  return [...new Set(names)]
}

/**
 * Automatically download and decrypt all standard packs if they are missing.
 * This can be safely imported and run by other scripts.
 */
export async function ensurePacksDownloaded() {
  mkdirSync(OUT, { recursive: true })

  for (const packId of PACKS) {
    const dir = join(OUT, packId)
    const indexPath = join(dir, 'index.json')

    if (existsSync(indexPath)) {
      continue // Already downloaded
    }

    console.log(`\n📦 Missing premium pack detected: "${packId}". Downloading now...`)
    mkdirSync(dir, { recursive: true })

    let manifest
    try {
      const data = await fetchJSON(MANIFEST_URL(packId))
      manifest = data?.[0]
      if (!manifest?.stickers?.length) throw new Error('manifest empty')
    } catch (e) {
      console.log(`— skipped "${packId}" (${e.message})`)
      continue
    }

    const stickers = manifest.stickers
    console.log(`— Downloading ${stickers.length} stickers...`)
    const index = []

    for (let i = 0; i < stickers.length; i++) {
      const s = stickers[i]
      const num = String(i + 1).padStart(2, '0')

      try {
        const enc = await fetchBytes(s['direct-path'])
        const dec = decryptSticker(enc, s['media-key'])

        const hash = sha256b64(dec)
        if (hash !== s['file-hash']) {
          console.log(`  ❌ ${num} hash mismatch`)
          continue
        }

        const fname = `${packId}_${num}.was`
        writeFileSync(join(dir, fname), dec)

        index.push({
          file: fname,
          emojis: s.emojis || [],
          alt: s['accessibility-text'] || '',
          size: dec.length,
          mediaKey: s['media-key'],
          fileHash: s['file-hash'],
          encFileHash: s['enc-file-hash'],
          mimetype: s.mimetype,
          width: s.width,
          height: s.height,
          directPath: s['direct-path'],
        })
      } catch (e) {
        console.log(`  ❌ ${num} download/decryption failed: ${e.message}`)
      }
    }

    writeFileSync(indexPath, JSON.stringify(index, null, 2))
    console.log(`✅ Pack "${packId}" downloaded, decrypted, and indexed successfully!`)
  }
}

/**
 * Return every locally available sticker and persist Lottie animation names in
 * each pack index. Name extraction only happens once after a pack is downloaded.
 */
export async function getStickerCatalog() {
  await ensurePacksDownloaded()
  const catalog = []

  for (const packId of PACKS) {
    const dir = join(OUT, packId)
    const indexPath = join(dir, 'index.json')
    if (!existsSync(indexPath)) continue

    const index = JSON.parse(readFileSync(indexPath, 'utf8'))
    let changed = false

    for (const sticker of index) {
      // Some manifests contain legacy WebP stickers under a .was filename.
      // They do not contain a Lottie document and cannot be sent as premium
      // lottieStickerMessage payloads.
      if (sticker.mimetype !== 'application/was') continue

      const wasPath = join(dir, sticker.file)

      if (!Array.isArray(sticker.names) || sticker.names.length === 0) {
        try {
          sticker.names = extractAnimationNames(wasPath)
        } catch (err) {
          console.log(`Could not extract animation name from "${wasPath}": ${err.message}`)
          sticker.names = []
        }
        changed = true
      }

      if (sticker.names.length > 0) {
        catalog.push({
          ...sticker,
          packId,
          wasPath,
          name: sticker.names[0],
        })
      }
    }

    if (changed) {
      writeFileSync(indexPath, JSON.stringify(index, null, 2))
    }
  }

  return catalog
}

/**
 * Modular programmatic function to upload and send any custom premium .was sticker.
 * Can be called with a custom socket or we spin up a new temporary one.
 */
export async function sendPremiumSticker({
    jid,
    packId,
    fileNumber,
    emoji,
    random,
    wasPath,
    sock,
    customAuthDir = './auth_info_android_bypass'
}) {
    // 1. Resolve which local .was file to use
    let targetWasPath = null
    let chosenFilename = 'custom'

    if (wasPath) {
        targetWasPath = wasPath
        chosenFilename = join(wasPath).split('/').pop()
    } else {
        await ensurePacksDownloaded()
        
        if (!packId || !PACKS.includes(packId)) {
            throw new Error(`Invalid or missing packId. Choose from: ${PACKS.join(', ')}`)
        }

        const dir = join(OUT, packId)
        const indexData = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))

        let selected = null

        if (emoji) {
            // Find sticker matching emoji
            selected = indexData.find(s => s.emojis && s.emojis.includes(emoji))
            if (!selected) {
                console.log(`Warning: No sticker found matching emoji "${emoji}" in pack "${packId}". Falling back to first sticker.`)
                selected = indexData[0]
            }
        } else if (random) {
            // Select random
            const idx = Math.floor(Math.random() * indexData.length)
            selected = indexData[idx]
        } else if (fileNumber) {
            // Select by sticker index/number
            const numStr = String(fileNumber).padStart(2, '0')
            selected = indexData.find(s => s.file.includes(`_${numStr}.was`))
            if (!selected) {
                throw new Error(`Sticker number "${numStr}" not found in pack "${packId}".`)
            }
        } else {
            // Default to first
            selected = indexData[0]
        }

        targetWasPath = join(dir, selected.file)
        chosenFilename = selected.file
    }

    if (!existsSync(targetWasPath)) {
        throw new Error(`Resolved sticker path does not exist: ${targetWasPath}`)
    }

    console.log(`Using sticker file: "${targetWasPath}"`)

    // 2. Manage Socket connection
    let activeSock = sock
    let temporaryConnection = false

    if (!activeSock) {
        temporaryConnection = true
        console.log('No active socket provided. Spawning a temporary connection...')
        const { state, saveCreds } = await useMultiFileAuthState(customAuthDir)
        
        activeSock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Pixel 10', 'WhatsApp', '2.26.16.73'],
            syncFullHistory: false
        })

        activeSock.ev.on('creds.update', saveCreds)

        // Wait for connection to open
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                activeSock.end()
                reject(new Error('WhatsApp connection timed out (20s).'))
            }, 20000)

            activeSock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect } = update
                if (connection === 'open') {
                    clearTimeout(timeout)
                    resolve()
                } else if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode
                    if (statusCode === DisconnectReason.loggedOut) {
                        clearTimeout(timeout)
                        reject(new Error('Session logged out. Please re-pair.'))
                    }
                }
            })
        })
        console.log('Connected!')
    }

    // 3. Upload and send
    try {
        console.log(`Uploading "${chosenFilename}" to WhatsApp servers...`)
        const buffer = readFileSync(targetWasPath)
        
        const prepared = await prepareWAMessageMedia(
            { sticker: buffer },
            { upload: activeSock.waUploadToServer }
        )

        const stickerMsg = prepared.stickerMessage
        stickerMsg.mimetype = "application/was"
        stickerMsg.isAnimated = true
        stickerMsg.isLottie = true

        const payload = {
            lottieStickerMessage: {
                message: {
                    stickerMessage: stickerMsg
                }
            }
        }

        console.log(`Relaying premium sticker to: ${jid}`)
        const messageId = activeSock.generateMessageID ? activeSock.generateMessageID() : undefined
        await activeSock.relayMessage(jid, payload, { messageId })
        console.log('>>> Premium sticker sent successfully! <<<')
        return { jid, filename: chosenFilename, messageId }

    } catch (err) {
        console.error('Failed to send premium sticker:', err)
        throw err
    } finally {
        // If we opened a temporary connection, close it
        if (temporaryConnection) {
            console.log('Closing temporary socket connection...')
            activeSock.end()
        }
    }
}

// ── Interactive CLI Fallback ────────────────────────────────────────
const isMainScript = import.meta.url === `file://${process.argv[1]}` || process.argv[1] === 'sendstickers.js' || process.argv[1]?.endsWith('/sendstickers.js')

if (isMainScript) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    })

    const askOptions = async () => {
        try {
            await ensurePacksDownloaded()

            console.log('\n=========================================')
            console.log('    WHATSAPP PREMIUM STICKER SENDER     ')
            console.log('=========================================')
            
            // 1. Input JID
            const jidInput = await rl.question('\nEnter recipient JID (e.g., 51445302861964@lid or 120363421406696113@g.us):\n> ')
            const jid = jidInput.trim()
            if (!jid) {
                console.log('Error: JID cannot be empty.')
                process.exit(1)
            }

            // 2. Select Pack
            console.log('\nAvailable Premium Sticker Packs:')
            PACKS.forEach((p, idx) => console.log(`  [${idx + 1}] ${p}`))
            const packIdxInput = await rl.question('\nSelect a pack (1-8):\n> ')
            const packIdx = parseInt(packIdxInput.trim(), 10) - 1
            if (isNaN(packIdx) || packIdx < 0 || packIdx >= PACKS.length) {
                console.log('Invalid pack selection.')
                process.exit(1)
            }
            const packId = PACKS[packIdx]

            // 3. Select selection method
            console.log('\nSticker Selection Method:')
            console.log('  [1] Select by file index / number (e.g. 01, 02)')
            console.log('  [2] Select by emoji')
            console.log('  [3] Choose a completely random sticker')
            const methodInput = await rl.question('\nChoose option (1-3):\n> ')
            const method = methodInput.trim()

            let fileNumber = null
            let emoji = null
            let random = false

            if (method === '1') {
                const numInput = await rl.question('\nEnter sticker index (e.g. 01, 12, etc.):\n> ')
                fileNumber = numInput.trim()
            } else if (method === '2') {
                const emojiInput = await rl.question('\nEnter a matching emoji (e.g. 😎, 😂, 😭):\n> ')
                emoji = emojiInput.trim()
            } else if (method === '3') {
                random = true
            } else {
                console.log('Defaulting to first sticker in pack.')
            }

            rl.close()

            // 4. Run the sender
            await sendPremiumSticker({ jid, packId, fileNumber, emoji, random })

        } catch (err) {
            console.error('\nExecution failed:', err.message)
            rl.close()
            process.exit(1)
        }
    }

    askOptions()
}