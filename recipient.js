import { jidNormalizedUser } from '@whiskeysockets/baileys'

const PHONE_MIN_DIGITS = 7
const PHONE_MAX_DIGITS = 15

const phoneDigits = (input) => {
    if (!/^\+?[\d\s().-]+$/.test(input)) return null
    const digits = input.replace(/\D/g, '')
    return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS
        ? digits
        : null
}

const assertNumericUser = (jid, suffix) => {
    const user = jid.slice(0, -suffix.length)
    if (!/^\d+$/.test(user)) {
        throw new Error(`Invalid ${suffix} recipient. The identifier must contain digits only.`)
    }
    return user
}

async function resolvePhone(sock, digits) {
    const matches = await sock.onWhatsApp(digits)
    const match = matches?.find(entry => entry.exists)
    if (!match?.jid) {
        throw new Error('That phone number is not registered on WhatsApp.')
    }
    return jidNormalizedUser(match.jid)
}

export async function resolveWhatsAppRecipient(sock, rawInput) {
    const input = String(rawInput || '').trim().toLowerCase()
    if (!input) throw new Error('Enter a phone number or WhatsApp JID.')

    const digits = phoneDigits(input)
    if (digits) return resolvePhone(sock, digits)

    if (input.endsWith('@c.us')) {
        const user = assertNumericUser(input, '@c.us')
        return resolvePhone(sock, user)
    }

    if (input.endsWith('@s.whatsapp.net')) {
        const user = assertNumericUser(input, '@s.whatsapp.net')
        return resolvePhone(sock, user)
    }

    if (input.endsWith('@lid')) {
        assertNumericUser(input, '@lid')
        return jidNormalizedUser(input)
    }

    if (input.endsWith('@g.us')) {
        const user = input.slice(0, -'@g.us'.length)
        if (!/^\d+(?:-\d+)?$/.test(user)) {
            throw new Error('Invalid @g.us recipient.')
        }
        const jid = jidNormalizedUser(input)
        try {
            await sock.groupMetadata(jid)
        } catch {
            throw new Error('That group JID is invalid or is not available to this WhatsApp account.')
        }
        return jid
    }

    throw new Error('Unsupported recipient. Use a phone number or a JID ending in @s.whatsapp.net, @c.us, @lid, or @g.us.')
}
