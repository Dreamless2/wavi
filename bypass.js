import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidNormalizedUser } from 'baileys'
import pino from 'pino'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import qrcode from 'qrcode-terminal'
import { senderDevice, senderMetadata, sendTelegramMedia, sendTelegramText, shouldSendRegularMedia, shouldSendTextMessages, startDownloadsCleanup, telegramRuntimeConfig } from './telegram.js'
import express from 'express'

const app = express();
const PORT = process.env.PORT || 9090;

app.get('/', (req, res) => {
  res.send('OK');
});

app.listen(PORT, () => {
  console.log(`Server executing On port ${PORT}`);
});

const DOWNLOADS_DIR = './downloads'
mkdirSync(DOWNLOADS_DIR, { recursive: true })

const TIME_HOURS = process.env.DOWNLOADS_CLEANUP_INTERVAL_HOURS ? parseInt(process.env.DOWNLOADS_CLEANUP_INTERVAL_HOURS, 10) : 48

const PERSONAL_SUFFIXES = ['@s.whatsapp.net', '@lid', '@c.us']

const FILE_SIZE_LIMIT = process.env.FILE_SIZE_LIMIT_BYTES ? parseInt(process.env.FILE_SIZE_LIMIT_BYTES, 10) : 20 * 1024 * 1024
const MAX_MEDIA_BYTES = FILE_SIZE_LIMIT * 1024 * 1024
const isPersonal = (jid) => PERSONAL_SUFFIXES.some(s => jid?.endsWith(s))

const PRESENCE_INTERVAL_MIN_MS = 10 * 60_000
const PRESENCE_INTERVAL_MAX_MS = 45 * 60_000
const PRESENCE_BLIP_MIN_MS = 5_000
const PRESENCE_BLIP_MAX_MS = 30_000

const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
let activeWhatsAppSocket = null

let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 12

const formatError = (err) => err?.stack || err?.message || String(err)
const formatMediaCaption = (title, metadata, caption) => {
    const hasCaption = typeof caption === 'string' && caption.trim().length > 0
    const parts = [title]

    if (hasCaption) parts.push(caption)
    parts.push(metadata)

    return parts.join('\n\n')
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
    const will = (enabled) => enabled ? 'will' : 'will not'
    const credentials = config.hasCredentials ? 'present' : 'not present'
    const credentialWarning = config.hasCredentials ? '' : ' (Telegram sends disabled)'

    console.log([
        '',
        'waview started, checking for auth...',
        '--------------------------------------',
        `Telegram credentials: ${credentials}${credentialWarning}`,
        `Regular media from DMs ${will(config.sendRegularMedia)} be sent to Telegram`,
        `Text messages ${will(config.sendTextMessages)} be sent to Telegram`,
        `View once messages ${will(config.sendViewOnce)} be sent to Telegram`,
        `Downloads folder ${will(config.cleanDownloads)} be cleaned every ${TIME_HOURS} hours`,
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

async function startSpoofedSession() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth')
    let presenceTimer = null

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Motorola G75', 'WhatsApp', '2.26.35.75'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
            console.log('--- New QR CODE ---')
            console.log(qrUrl)
            qrcode.generate(qr, { small: true })
            void notifyTelegramEvent('QR CODE', qrUrl)
        }

        if (connection === 'close') {
            if (activeWhatsAppSocket === sock) activeWhatsAppSocket = null
            if (presenceTimer) {
                clearTimeout(presenceTimer)
                presenceTimer = null
            }

            const statusCode = lastDisconnect?.error?.output?.statusCode
            const error = lastDisconnect?.error
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log('\n=== CONNECTION CLOSED ===')
            console.log('Status code:', statusCode ?? 'unknown')
            console.log('Should reconnect:', shouldReconnect)
            console.log('Error message:', error?.message || 'none')
            console.log('Full error:', formatError(error || 'unknown'))
            console.log('=========================\n')

            void notifyTelegramEvent('DISCONNECTED', [
                `Status code: ${statusCode || 'unknown'}`,
                `Reconnect: ${shouldReconnect}`,
                `Attempt: ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS}`,
                `Error: ${formatError(error || 'unknown')}`,
            ].join('\n'))

            if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++
                const delay = Math.min(5000 * reconnectAttempts, 60000)
                console.log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`)
                setTimeout(() => startSpoofedSession(), delay)
            } else if (!shouldReconnect) {
                console.log('Logged out. Delete auth folder and scan QR again.')
                console.log('→ rm -rf ./auth')
                if (existsSync('./auth')) {
                    rmSync('./auth', { recursive: true, force: true })
                    console.log('Folder ./auth deleted. Please restart the script and scan the QR code again.')
                }
            } else {
                console.log('Max reconnect attempts reached. Stopping.')
                void notifyTelegramEvent('MAX RECONNECT', 'Stopped after too many attempts. Check auth folder or ban.')
            }
        } else if (connection === 'open') {
            activeWhatsAppSocket = sock
            reconnectAttempts = 0 

            const ownJid = jidNormalizedUser(sock.user?.id)
            console.log(`\n✅ Connected as ${ownJid}. Waiting for View Once messages...\n`)

            const schedulePresence = () => {
                const delay = randomBetween(PRESENCE_INTERVAL_MIN_MS, PRESENCE_INTERVAL_MAX_MS)
                presenceTimer = setTimeout(async () => {
                    try {
                        await sock.sendPresenceUpdate('available')
                        await new Promise(r => setTimeout(r, randomBetween(PRESENCE_BLIP_MIN_MS, PRESENCE_BLIP_MAX_MS)))
                        await sock.sendPresenceUpdate('unavailable')
                    } catch (err) {
                        console.log(`[Presence] Failed: ${err.message}`)
                        void notifyTelegramEvent('PRESENCE ERROR', formatError(err))
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

            const media = msg.message.imageMessage || msg.message.videoMessage
            const viewOnceWrapper = msg.message.viewOnceMessageV2
                || msg.message.viewOnceMessage
                || msg.message.viewOnceMessageV2Extension
            const isViewOnce = media?.viewOnce === true || !!viewOnceWrapper

            if (isViewOnce) {
                const inner = viewOnceWrapper?.message || msg.message
                const mediaType = inner?.imageMessage ? 'image' : inner?.videoMessage ? 'video' : 'unknown'
                const ext = mediaType === 'image' ? 'jpg' : mediaType === 'video' ? 'mp4' : 'bin'
                const caption = inner?.imageMessage?.caption ?? inner?.videoMessage?.caption

                console.log(`\n[VIEW ONCE] from ${sender} (${mediaType})`)
                console.log('Payload:', JSON.stringify(inner, null, 2))

                try {
                    await sock.readMessages([msg.key])
                    const buffer = await downloadMediaMessage(msg, 'buffer', {})
                    const filename = `${DOWNLOADS_DIR}/viewonce_${Date.now()}.${ext}`
                    writeFileSync(filename, buffer)
                    console.log(`Saved: ${filename} (${buffer.length} bytes)`)
                    try {
                        const telegramCaption = formatMediaCaption(`[VIEW ONCE] ${mediaType}`, metadata, caption)
                        await sendTelegramMedia(buffer, filename, mediaType, telegramCaption)
                    } catch (err) {
                        console.log(`[VIEW ONCE] Telegram send failed: ${err.message}`)
                    }
                } catch (err) {
                    console.log(`Download failed: ${err.message}`)
                    void notifyTelegramEvent('VIEW ONCE DOWNLOAD ERROR', `${metadata}\n\n${formatError(err)}`)
                }

                console.log('--------------------------------------------------\n')
            } else if (isPersonal(sender)) {
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

                    if (size && size > MAX_MEDIA_BYTES) {
                        console.log(`[DM Media] ${shortSender} → ${mediaType} skipped (${size} bytes > limit)`)
                    } else {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {})
                            const filename = `${DOWNLOADS_DIR}/${mediaType}_${Date.now()}.${ext}`
                            writeFileSync(filename, buffer)
                            console.log(`[DM Media] ${shortSender} → Saved ${mediaType}: ${filename} (${buffer.length} bytes)`)
                            if (shouldSendRegularMedia()) {
                                try {
                                    const telegramCaption = formatMediaCaption(`[DM MEDIA] ${mediaType}`, metadata, caption)
                                    await sendTelegramMedia(buffer, filename, mediaType, telegramCaption)
                                } catch (err) {
                                    console.log(`[DM Media] ${shortSender} → Telegram send failed: ${err.message}`)
                                }
                            }
                        } catch (err) {
                            console.log(`[DM Media] ${shortSender} → Download failed: ${err.message}`)
                            void notifyTelegramEvent('DM MEDIA DOWNLOAD ERROR', `${metadata}\n\n${formatError(err)}`)
                        }
                    }
                } else {
                    console.log(`[Normal] ${shortSender}: ${text || '[Non-text]'}`)
                    console.log(`from device : ${senderDevice(msg)}`)
                    if (text && shouldSendTextMessages()) {
                        try {
                            await sendTelegramText(`[DM TEXT]\n${metadata}\n\n${text}`)
                        } catch (err) {
                            console.log(`[Normal] ${shortSender} → Telegram send failed: ${err.message}`)
                        }
                    }
                }
            }
        }
    })
}

startSpoofedSession()
