import { callTelegramBot, telegramBotConfig } from './telegram.js'
import { getStickerCatalog, sendPremiumSticker } from './sendstickers.js'
import { resolveWhatsAppRecipient } from './recipient.js'

const STICKER_PAGE_SIZE = 8
const EMOJI_PAGE_SIZE = 36
const EMOJI_COLUMNS = 6
const SESSION_TTL_MS = 15 * 60_000
const RETRY_DELAY_MS = 2_000
const sessions = new Map()

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const truncate = (value, max = 58) => value.length > max ? `${value.slice(0, max - 1)}…` : value
const keyboard = (rows) => ({ inline_keyboard: rows })
const button = (text, callbackData, style) => ({
    text,
    callback_data: callbackData,
    ...(style ? { style } : {}),
})

function sessionFor(chatId) {
    const session = sessions.get(chatId)
    if (!session || Date.now() - session.updatedAt > SESSION_TTL_MS) {
        sessions.delete(chatId)
        return null
    }
    session.updatedAt = Date.now()
    return session
}

async function sendMessage(chatId, text, replyMarkup) {
    return callTelegramBot('sendMessage', {
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })
}

async function editMessage(chatId, messageId, text, replyMarkup) {
    try {
        await callTelegramBot('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        })
    } catch (err) {
        if (!err.message.includes('message is not modified')) throw err
    }
}

async function answerCallback(callbackId, text) {
    await callTelegramBot('answerCallbackQuery', {
        callback_query_id: callbackId,
        ...(text ? { text } : {}),
    }).catch(() => {})
}

function modeKeyboard() {
    return keyboard([
        [button('By emoji', 'stk:mode:emoji', 'primary')],
        [button('By pack', 'stk:mode:pack', 'primary')],
        [button('Random', 'stk:mode:random', 'success')],
        [button('Cancel', 'stk:cancel', 'danger')],
    ])
}

function paginatedKeyboard(items, page, callbackPrefix, labelFor, {
    pageSize = STICKER_PAGE_SIZE,
    columns = 1,
} = {}) {
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
    const safePage = Math.min(Math.max(page, 0), pageCount - 1)
    const start = safePage * pageSize
    const pageButtons = items.slice(start, start + pageSize).map((item, offset) =>
        button(truncate(labelFor(item)), `${callbackPrefix}:${start + offset}`, 'primary'))
    const rows = []

    for (let index = 0; index < pageButtons.length; index += columns) {
        rows.push(pageButtons.slice(index, index + columns))
    }

    const navigation = []

    if (safePage > 0) navigation.push(button('‹ Previous', `stk:page:${safePage - 1}`, 'primary'))
    navigation.push(button(`${safePage + 1}/${pageCount}`, 'stk:noop'))
    if (safePage + 1 < pageCount) navigation.push(button('Next ›', `stk:page:${safePage + 1}`, 'primary'))
    rows.push(navigation)
    rows.push([button('Cancel', 'stk:cancel', 'danger')])
    return keyboard(rows)
}

function stickerLabel(sticker) {
    return `${sticker.name} — ${sticker.packId}`
}

async function showStickerChoices(chatId, messageId, session, page = 0) {
    session.page = page
    session.phase = 'choose_sticker'
    await editMessage(
        chatId,
        messageId,
        `Choose the exact Lottie animation name (${session.filtered.length} match${session.filtered.length === 1 ? '' : 'es'}):`,
        paginatedKeyboard(session.filtered, page, 'stk:item', stickerLabel),
    )
}

async function showRandomChoice(chatId, messageId, session) {
    const index = Math.floor(Math.random() * session.catalog.length)
    session.selected = session.catalog[index]
    session.phase = 'confirm_random'
    await editMessage(
        chatId,
        messageId,
        `Random selection:\n${session.selected.name}\nPack: ${session.selected.packId}\nFile: ${session.selected.file}`,
        keyboard([
            [button('Use this sticker', 'stk:random:use', 'success')],
            [button('Reroll', 'stk:random:reroll', 'primary')],
            [button('Cancel', 'stk:cancel', 'danger')],
        ]),
    )
}

async function askForRecipient(chatId, session) {
    session.phase = 'await_recipient'
    const prompt = await sendMessage(
        chatId,
        `Selected: ${session.selected.name}\nPack: ${session.selected.packId}\n\nReply with a phone number or a JID ending in @s.whatsapp.net, @c.us, @lid, or @g.us.`,
        { force_reply: true, selective: true, input_field_placeholder: '+491701234567 or 123@lid' },
    )
    session.promptMessageId = prompt.message_id
}

async function beginStickerFlow(chatId, getSocket) {
    if (!getSocket()) {
        await sendMessage(chatId, 'WhatsApp is disconnected. Try again after it reconnects.')
        return
    }

    const waiting = await sendMessage(chatId, 'Loading the sticker catalog…')
    try {
        const catalog = await getStickerCatalog()
        if (catalog.length === 0) throw new Error('No premium stickers are available.')

        sessions.set(chatId, {
            phase: 'choose_mode',
            catalog,
            packIds: [...new Set(catalog.map(item => item.packId))],
            menuMessageId: waiting.message_id,
            updatedAt: Date.now(),
        })
        await editMessage(chatId, waiting.message_id, 'How do you want to find the sticker?', modeKeyboard())
    } catch (err) {
        await editMessage(chatId, waiting.message_id, `Could not load stickers: ${err.message}`)
    }
}

async function handleCallback(query, getSocket) {
    const chatId = String(query.message?.chat?.id || '')
    const messageId = query.message?.message_id
    const data = query.data || ''

    if (data === 'stk:noop') {
        await answerCallback(query.id)
        return
    }

    const session = sessionFor(chatId)
    if (!session) {
        await answerCallback(query.id, 'This selection expired.')
        await editMessage(chatId, messageId, 'This sticker selection expired. Send /sticker to start again.')
        return
    }
    if (session.menuMessageId !== messageId) {
        await answerCallback(query.id, 'This menu is no longer active.')
        return
    }

    await answerCallback(query.id)
    if (data === 'stk:cancel') {
        sessions.delete(chatId)
        await editMessage(chatId, messageId, 'Sticker selection cancelled.')
        return
    }

    if (data === 'stk:mode:pack' && session.phase === 'choose_mode') {
        session.phase = 'choose_pack'
        const packButtons = session.packIds.map((packId, index) =>
            button(packId, `stk:pack:${index}`, 'primary'))
        const rows = []
        for (let index = 0; index < packButtons.length; index += 2) {
            rows.push(packButtons.slice(index, index + 2))
        }
        rows.push([button('Cancel', 'stk:cancel', 'danger')])
        await editMessage(chatId, messageId, 'Choose a sticker pack:', keyboard(rows))
        return
    }

    if (data === 'stk:mode:emoji' && session.phase === 'choose_mode') {
        session.phase = 'choose_emoji'
        session.options = [...new Set(session.catalog.flatMap(item => item.emojis || []))].sort()
        if (session.options.length === 0) {
            await editMessage(chatId, messageId, 'No emoji metadata is available for these packs.')
            sessions.delete(chatId)
            return
        }
        await editMessage(
            chatId,
            messageId,
            'Choose an emoji:',
            paginatedKeyboard(session.options, 0, 'stk:emoji', value => value, {
                pageSize: EMOJI_PAGE_SIZE,
                columns: EMOJI_COLUMNS,
            }),
        )
        return
    }

    if (data === 'stk:mode:random' && session.phase === 'choose_mode') {
        await showRandomChoice(chatId, messageId, session)
        return
    }

    if (data.startsWith('stk:pack:') && session.phase === 'choose_pack') {
        const packId = session.packIds[Number(data.split(':')[2])]
        session.filtered = session.catalog.filter(item => item.packId === packId)
        if (!packId || session.filtered.length === 0) throw new Error('That pack is unavailable.')
        await showStickerChoices(chatId, messageId, session)
        return
    }

    if (data.startsWith('stk:emoji:') && session.phase === 'choose_emoji') {
        const selectedEmoji = session.options[Number(data.split(':')[2])]
        session.filtered = session.catalog.filter(item => item.emojis?.includes(selectedEmoji))
        if (!selectedEmoji || session.filtered.length === 0) throw new Error('No sticker matches that emoji.')
        await showStickerChoices(chatId, messageId, session)
        return
    }

    if (data.startsWith('stk:page:')) {
        const page = Number(data.split(':')[2])
        if (session.phase === 'choose_sticker') {
            await showStickerChoices(chatId, messageId, session, page)
        } else if (session.phase === 'choose_emoji') {
            await editMessage(
                chatId,
                messageId,
                'Choose an emoji:',
                paginatedKeyboard(session.options, page, 'stk:emoji', value => value, {
                    pageSize: EMOJI_PAGE_SIZE,
                    columns: EMOJI_COLUMNS,
                }),
            )
        }
        return
    }

    if (data.startsWith('stk:item:') && session.phase === 'choose_sticker') {
        session.selected = session.filtered[Number(data.split(':')[2])]
        if (!session.selected) throw new Error('That sticker is unavailable.')
        await editMessage(
            chatId,
            messageId,
            `Selected exact animation:\n${session.selected.name}\nPack: ${session.selected.packId}\nFile: ${session.selected.file}`,
        )
        await askForRecipient(chatId, session)
        return
    }

    if (data === 'stk:random:reroll' && session.phase === 'confirm_random') {
        await showRandomChoice(chatId, messageId, session)
        return
    }

    if (data === 'stk:random:use' && session.phase === 'confirm_random') {
        await editMessage(
            chatId,
            messageId,
            `Selected exact animation:\n${session.selected.name}\nPack: ${session.selected.packId}\nFile: ${session.selected.file}`,
        )
        await askForRecipient(chatId, session)
    }
}

async function handleRecipientMessage(message, session, getSocket) {
    const chatId = String(message.chat.id)
    if (message.reply_to_message?.message_id !== session.promptMessageId) return

    const sock = getSocket()
    if (!sock) {
        sessions.delete(chatId)
        await sendMessage(chatId, 'WhatsApp disconnected before the sticker could be sent.')
        return
    }

    session.phase = 'sending'
    await sendMessage(chatId, 'Validating the recipient and sending…')

    let jid
    try {
        jid = await resolveWhatsAppRecipient(sock, message.text)
    } catch (err) {
        session.phase = 'await_recipient'
        const prompt = await sendMessage(
            chatId,
            `Invalid recipient: ${err.message}\n\nReply with a corrected recipient, or send /cancel.`,
            { force_reply: true, selective: true },
        )
        session.promptMessageId = prompt.message_id
        return
    }

    try {
        const result = await sendPremiumSticker({
            jid,
            wasPath: session.selected.wasPath,
            sock,
        })
        await sendMessage(
            chatId,
            `Sticker sent.\nAnimation: ${session.selected.name}\nPack: ${session.selected.packId}\nRecipient: ${jid}${result.messageId ? `\nMessage ID: ${result.messageId}` : ''}`,
        )
        sessions.delete(chatId)
    } catch (err) {
        // Do not automatically retry a relay: the server may have accepted it
        // even if the local acknowledgement failed, which could duplicate it.
        sessions.delete(chatId)
        await sendMessage(
            chatId,
            `Sticker send failed: ${err.message}\nSend /sticker to start a new attempt.`,
        )
    }
}

async function handleUpdate(update, allowedChatId, getSocket) {
    const message = update.message
    const callback = update.callback_query
    const chatId = String(message?.chat?.id || callback?.message?.chat?.id || '')

    // The existing outbound CHAT_ID is the complete allowlist.
    if (chatId !== allowedChatId) return

    if (callback) {
        try {
            await handleCallback(callback, getSocket)
        } catch (err) {
            await sendMessage(chatId, `Sticker selection failed: ${err.message}`)
        }
        return
    }

    if (!message?.text) return
    const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase()

    if (command === '/start') {
        await sendMessage(
            chatId,
            'Premium sticker bridge ready.\nUse /sticker to choose and send a sticker to WhatsApp.',
        )
    } else if (command === '/sticker') {
        await beginStickerFlow(chatId, getSocket)
    } else if (command === '/cancel') {
        sessions.delete(chatId)
        await sendMessage(chatId, 'Sticker selection cancelled.')
    } else {
        const session = sessionFor(chatId)
        if (session?.phase === 'await_recipient') {
            await handleRecipientMessage(message, session, getSocket)
        }
    }
}

export function startStickerBridge(getSocket) {
    const config = telegramBotConfig()
    if (!config.enabled) {
        console.log('[Sticker Bridge] Disabled: TELEGRAM_BOT_TOKEN and CHAT_ID are required')
        return () => {}
    }

    const controller = new AbortController()
    let offset = 0

    const poll = async () => {
        try {
            await callTelegramBot('setMyCommands', {
                commands: [
                    { command: 'start', description: 'Start the sticker bridge' },
                    { command: 'sticker', description: 'Send a premium WhatsApp sticker' },
                ],
            }, controller.signal)
            await callTelegramBot('deleteWebhook', { drop_pending_updates: true }, controller.signal)
            console.log(`[Sticker Bridge] Polling Telegram; allowed chat: ${config.chatId}`)

            while (!controller.signal.aborted) {
                try {
                    const updates = await callTelegramBot('getUpdates', {
                        offset,
                        timeout: 25,
                        allowed_updates: ['message', 'callback_query'],
                    }, controller.signal)

                    for (const update of updates) {
                        offset = Math.max(offset, update.update_id + 1)
                        await handleUpdate(update, config.chatId, getSocket)
                    }
                } catch (err) {
                    if (controller.signal.aborted || err.name === 'AbortError') break
                    console.log(`[Sticker Bridge] Poll failed: ${err.message}`)
                    await sleep(RETRY_DELAY_MS)
                }
            }
        } catch (err) {
            if (!controller.signal.aborted) {
                console.log(`[Sticker Bridge] Could not start: ${err.message}`)
            }
        }
    }

    void poll()
    return () => controller.abort()
}