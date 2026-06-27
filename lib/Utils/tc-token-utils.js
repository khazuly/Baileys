"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const {
  getBinaryNodeChild,
  getBinaryNodeChildren,
  isHostedLidUser,
  isHostedPnUser,
  isJidMetaAI,
  isLidUser,
  isPnUser,
  jidNormalizedUser
} = require("../WABinary")

const BOT_PHONE_REGEX = /^1313555\d{4}$|^131655500\d{2}$/
const TC_TOKEN_BUCKET_DURATION = 604800
const TC_TOKEN_NUM_BUCKETS = 4
const TC_TOKEN_INDEX_KEY = '__index'

const isRegularUser = (jid) => {
    if (!jid) return false
    const user = jid.split('@')[0] || ''
    if (user === '0') return false
    if (BOT_PHONE_REGEX.test(user)) return false
    if (isJidMetaAI(jid)) return false
    return !!(isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid) || jid.endsWith('@c.us'))
}

const readTcTokenIndex = async (keys) => {
    const data = await keys.get('tctoken', [TC_TOKEN_INDEX_KEY])
    const entry = data[TC_TOKEN_INDEX_KEY]
    if (!entry?.token?.length) return []

    try {
        const parsed = JSON.parse(Buffer.from(entry.token).toString())
        if (!Array.isArray(parsed)) return []
        return parsed.filter(jid => typeof jid === 'string' && jid.length > 0 && jid !== TC_TOKEN_INDEX_KEY)
    } catch {
        return []
    }
}

const buildMergedTcTokenIndexWrite = async (keys, addedJids) => {
    const persisted = await readTcTokenIndex(keys)
    const merged = new Set(persisted)

    for (const jid of addedJids) {
        if (jid && jid !== TC_TOKEN_INDEX_KEY) {
            merged.add(jid)
        }
    }

    return {
        [TC_TOKEN_INDEX_KEY]: { token: Buffer.from(JSON.stringify([...merged])) }
    }
}

const isTcTokenExpired = (timestamp) => {
    if (timestamp === null || timestamp === undefined) return true
    const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp
    if (Number.isNaN(ts)) return true

    const now = Math.floor(Date.now() / 1000)
    const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
    const cutoffBucket = currentBucket - (TC_TOKEN_NUM_BUCKETS - 1)
    const cutoffTimestamp = cutoffBucket * TC_TOKEN_BUCKET_DURATION
    return ts < cutoffTimestamp
}

const shouldSendNewTcToken = (senderTimestamp) => {
    if (senderTimestamp === undefined) return true
    const now = Math.floor(Date.now() / 1000)
    const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
    const senderBucket = Math.floor(senderTimestamp / TC_TOKEN_BUCKET_DURATION)
    return currentBucket > senderBucket
}

const resolveTcTokenJid = async (jid, getLIDForPN) => {
    if (isLidUser(jid)) return jid
    const lid = await getLIDForPN(jid)
    return lid || jid
}

const resolveIssuanceJid = async (jid, issueToLid, getLIDForPN, getPNForLID) => {
    if (issueToLid) {
        if (isLidUser(jid)) return jid
        const lid = await getLIDForPN(jid)
        return lid || jid
    }

    if (!isLidUser(jid)) return jid
    if (getPNForLID) {
        const pn = await getPNForLID(jid)
        return pn || jid
    }

    return jid
}

const pushUniqueRegularJid = (jids, jid) => {
    if (!jid) return

    const normalized = jidNormalizedUser(jid)
    if (!isRegularUser(normalized) || jids.includes(normalized)) {
        return
    }

    jids.push(normalized)
}

const resolvePrivacyTokenIssueJids = async (jid, issueToLid, getLIDForPN, getPNForLID) => {
    const jids = []
    const normalizedJid = jidNormalizedUser(jid)
    const primaryJid = await resolveIssuanceJid(normalizedJid, issueToLid, getLIDForPN, getPNForLID)

    if (isLidUser(normalizedJid)) {
        pushUniqueRegularJid(jids, normalizedJid)
        pushUniqueRegularJid(jids, primaryJid)

        if (getPNForLID) {
            pushUniqueRegularJid(jids, await getPNForLID(normalizedJid))
        }
    } else {
        pushUniqueRegularJid(jids, primaryJid)
        pushUniqueRegularJid(jids, normalizedJid)
        pushUniqueRegularJid(jids, await getLIDForPN(normalizedJid))
    }

    return jids
}

const buildTcTokenFromJid = async ({ authState, jid, baseContent = [], getLIDForPN }) => {
    try {
        const storageJid = await resolveTcTokenJid(jid, getLIDForPN)
        const tcTokenData = await authState.keys.get('tctoken', [storageJid])
        const entry = tcTokenData?.[storageJid]
        const tcTokenBuffer = entry?.token
        const timestamp = entry?.timestamp

        if (!tcTokenBuffer?.length || timestamp === undefined || isTcTokenExpired(timestamp)) {
            if (tcTokenBuffer) {
                const cleared = entry?.senderTimestamp !== undefined
                    ? { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp }
                    : null
                await authState.keys.set({ tctoken: { [storageJid]: cleared } })
            }

            return baseContent.length > 0 ? baseContent : undefined
        }

        baseContent.push({
            tag: 'tctoken',
            attrs: { t: String(timestamp) },
            content: tcTokenBuffer
        })

        return baseContent
    } catch {
        return baseContent.length > 0 ? baseContent : undefined
    }
}

const storeTcTokensFromIqResult = async ({ result, fallbackJid, keys, getLIDForPN, onNewJidStored }) => {
    const storedJids = []
    if (!result) return storedJids

    const tokensNode = getBinaryNodeChild(result, 'tokens')
    if (!tokensNode) return storedJids

    const tokenNodes = getBinaryNodeChildren(tokensNode, 'token')
    for (const tokenNode of tokenNodes) {
        if (tokenNode.attrs.type !== 'trusted_contact' || !(tokenNode.content instanceof Uint8Array)) {
            continue
        }

        const rawJid = jidNormalizedUser(fallbackJid || tokenNode.attrs.jid)
        if (!isRegularUser(rawJid)) continue

        const storageJid = await resolveTcTokenJid(rawJid, getLIDForPN)
        const existingTcData = await keys.get('tctoken', [storageJid])
        const existingEntry = existingTcData[storageJid]
        const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0
        const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : 0

        if (!incomingTs) continue
        if (existingTs > 0 && existingTs > incomingTs) continue

        await keys.set({
            tctoken: {
                [storageJid]: {
                    ...existingEntry,
                    token: Buffer.from(tokenNode.content),
                    timestamp: tokenNode.attrs.t
                }
            }
        })

        onNewJidStored?.(storageJid)
        storedJids.push(storageJid)
    }

    return storedJids
}

module.exports = {
  TC_TOKEN_INDEX_KEY,
  buildMergedTcTokenIndexWrite,
  buildTcTokenFromJid,
  isTcTokenExpired,
  readTcTokenIndex,
  resolveIssuanceJid,
  resolvePrivacyTokenIssueJids,
  resolveTcTokenJid,
  shouldSendNewTcToken,
  storeTcTokensFromIqResult
}
