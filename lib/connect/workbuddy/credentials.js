/**
 * WorkBuddy 客户端本机登录态读取（只读客户端文件，两区域）。
 *
 * 移植自 dsh-connect-workbuddy@4.6.5（MIT，Copyright (c) 2026 LaoDing）的
 * auth.ts / at-rest.ts：
 *   - 桌面端 auth 目录扫描：Windows `%LOCALAPPDATA%` / `%APPDATA%`、macOS
 *     `~/Library/Application Support`、Linux `$XDG_CONFIG_HOME` 下的
 *     `CodeBuddyExtension/Data/Public/auth`；live 文件 `workbuddy-desktop.info`
 *     优先，带时间戳的 `.info` 备份按 `lastRefreshTime` 排序（`isFresher`）；
 *   - 文档解析两种形态：嵌套 `{"auth":{...},"account":{...}}` 与扁平形态；
 *     `expiresAt` 秒/毫秒自适应；账号 id = sha256(`workbuddy\0`+uin|uid) 前 24 hex；
 *   - 5.6.x 起桌面端字段加密（`{$wbEncrypted:1,envelope}`）：AES-256-GCM，
 *     key 由 App 自身原生模块的 `loggerGet()` payload 派生
 *     （`ELECTRON_RUN_AS_NODE` 起子进程问 App 要，进程内缓存，绝不落盘）；
 *   - 区域归属 `regionOf(domain)`：workbuddy.ai / codebuddy.ai → global，
 *     其余 → cn；区域 store 只看本区域账号。
 *
 * 与老插件的差异（红线要求）：
 *   - **不写任何凭据文件**：老插件把刷新后的 token 写进 DSH home 的
 *     workbuddy-vault；本插件刷新结果只放进程内存（`refreshedById` overlay），
 *     secret 不出进程内存与 loopback；
 *   - 无 OAuth 扫码登录、无 dismiss/账号管理（M3 只消费「是否已登录」）。
 *
 * @module dsh-agent-checkin/connect/workbuddy/credentials
 */

import { createHash, createDecipheriv } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, win32 } from 'node:path'
import { regionOf, refreshWorkBuddyToken } from './shim.js'

// ---------------------------------------------------------------------------
// 路径与常量（老插件 auth.ts 原样）
// ---------------------------------------------------------------------------

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'
/** Basename of the live WorkBuddy desktop auth file. */
export const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'
/** Env override pointing at the WorkBuddy desktop executable（取 at-rest key 用）. */
export const WORKBUDDY_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'

/**
 * Platform-default directories holding the WorkBuddy desktop app's auth file.
 * `platform`/`home`/`env` 可注入，平台分支因此可测。
 */
export function defaultDesktopAuthDirs(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  if (platform === 'win32') {
    const local = nonEmptyEnv(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
    const roaming = nonEmptyEnv(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    return [join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'), join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'linux') {
    const config = nonEmptyEnv(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  return []
}

/** A non-empty, trimmed env value, or undefined when unset/blank. */
function nonEmptyEnv(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
export function expiryToMs(value) {
  if (value <= 0) return 0
  return value > 0xe8d4a51000 ? value : value * 1e3
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
  return error?.code === 'ENOENT'
}

/**
 * Stable account id: sha256 hex sliced to 24 characters. `uin` is the billing
 * identity the upstream keys on; `uid` is the fallback.
 */
export function workbuddyAccountId(credential) {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? 'unknown'
  return createHash('sha256').update(`workbuddy\0${stable}`).digest('hex').slice(0, 24)
}

/** Filename of a path regardless of the host separator. */
export function authFileName(path) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator === -1 ? path : path.slice(separator + 1)
}

/**
 * The live `workbuddy-desktop.info` always wins: the upstream revokes the
 * tokens in the timestamped backups even though their `expiresAt` is future.
 */
function fileRank(path) {
  return authFileName(path) === WORKBUDDY_LIVE_FILENAME ? 0 : 1
}

/**
 * Whether `candidate` is a better pick than `incumbent` for the same account:
 * live file first, then most recent `lastRefreshAtMs`, then `expiresAtMs`.
 */
export function isFresher(candidate, incumbent) {
  const rankDiff = fileRank(candidate.filePath) - fileRank(incumbent.filePath)
  if (rankDiff !== 0) return rankDiff < 0
  const candidateRefresh = candidate.lastRefreshAtMs
  const incumbentRefresh = incumbent.lastRefreshAtMs
  if (candidateRefresh !== undefined && incumbentRefresh !== undefined) {
    if (candidateRefresh !== incumbentRefresh) return candidateRefresh > incumbentRefresh
  } else if (candidateRefresh !== undefined) return true
  else if (incumbentRefresh !== undefined) return false
  return candidate.expiresAtMs > incumbent.expiresAtMs
}

// ---------------------------------------------------------------------------
// at-rest 字段解密（老插件 at-rest.ts 原样）
// ---------------------------------------------------------------------------

/** Envelope framing names, mapped to the single-byte AAD framing code. */
const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 }
/** Standard (symmetric) format identifiers, transcripted into the AAD. */
const STANDARD_FORMAT_ID = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' }
/** Domain separator the AAD transcript starts with. */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')
/** Scheme name of the symmetric envelope this module opens. */
const SYMMETRIC_SCHEME = 'sym-v1'
/** How long the app is given to answer with its key payload. */
const KEY_FETCH_TIMEOUT_MS = 10_000
/** File names the WorkBuddy desktop executable goes by on Windows. */
const APP_EXECUTABLE_NAMES = ['WorkBuddy.exe', 'WorkBuddyAI.exe']
/**
 * Windows install directories the desktop app is observed to use, relative to
 * `%LOCALAPPDATA%` / `%ProgramFiles%` / `%ProgramFiles(x86)%`.
 */
const WINDOWS_APP_SUBDIRECTORIES = [
  ['Programs', 'WorkBuddy'],
  ['WorkBuddy'],
  ['Programs', 'WorkBuddyAI'],
  ['WorkBuddyAI'],
]
/** macOS bundles the desktop app may be installed as. */
const MACOS_APP_BUNDLE_NAMES = ['WorkBuddy.app', 'WorkBuddy AI.app']

function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** Length-prefixed UTF-8 string: uint32 big-endian length followed by the bytes. */
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/** The authenticated additional data for one `sym-v1` FIELD-framed envelope. */
function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('workbuddy: envelope keyId is malformed')
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID['field']),
    encodeLengthPrefixed(scheme),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE['field']]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/** Whether a value is the app's encrypted-field wrapper. */
export function isEncryptedFieldWrapper(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapper = value
  const keys = Object.keys(wrapper).sort()
  return keys.length === 2 && keys[0] === '$wbEncrypted' && keys[1] === 'envelope' && wrapper['$wbEncrypted'] === 1 && typeof wrapper['envelope'] === 'string'
}

/** The at-rest key id for a derived 32-byte key: first 16 hex chars of its SHA-256. */
export function deriveAtRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Derive the 32-byte field key from the app's key payload JSON: the app hashes
 * the payload's base64 STRING, so the same spelling is required here.
 */
export function deriveAtRestKey(payloadJson) {
  let payload
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('workbuddy: at-rest key payload is not valid JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('workbuddy: at-rest key payload is not an object')
  const secret = payload['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') throw new Error('workbuddy: at-rest key payload carries no atRestSecretKey')
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** Open one encrypted field with a derived key and return its plaintext. */
export function openEncryptedField(field, key) {
  let envelope
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  } catch {
    throw new Error('workbuddy: encrypted field envelope is not valid JSON')
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw new Error('workbuddy: encrypted field envelope is not an object')
  const record = envelope
  const suite = record['suite']
  const keyId = record['keyId']
  const nonce = record['nonce']
  const authTag = record['authTag']
  const ciphertext = record['ciphertext']
  if (typeof suite !== 'number' || typeof keyId !== 'string') throw new Error('workbuddy: encrypted field envelope is missing suite or keyId')
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') throw new Error('workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext')
  const expectedKeyId = deriveAtRestKeyId(key)
  if (keyId !== expectedKeyId) throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

/** The executable inside a macOS app bundle, read from the bundle's own Info.plist. */
function macosBundleExecutable(bundle) {
  let plist
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return undefined
  }
  const name = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1]?.trim()
  if (name === void 0 || name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') return undefined
  return join(bundle, 'Contents', 'MacOS', name)
}

/** Run `reg query` and return its stdout, or undefined when it cannot be run. */
function queryRegistry(args) {
  try {
    return execFileSync('reg', [...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  } catch {
    return undefined
  }
}

/** A registry executable value reduced to a usable path, or undefined. */
function normalizeRegistryExecutable(value) {
  const unquoted = stripRegistryQuotes(value)
  if (unquoted === undefined || unquoted === '') return undefined
  const withoutIndex = unquoted.replace(/,\s*-?\d+\s*$/u, '')
  if (withoutIndex === '') return undefined
  const base = win32.basename(withoutIndex).toLowerCase()
  if (!APP_EXECUTABLE_NAMES.some((name) => name.toLowerCase() === base)) return undefined
  return withoutIndex
}

/** The path inside a `DisplayIcon`/`InstallLocation` value, unquoted. */
function stripRegistryQuotes(value) {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (!trimmed.startsWith('"')) return trimmed
  const closing = trimmed.indexOf('"', 1)
  if (closing === -1) return undefined
  return trimmed.slice(1, closing).trim()
}

/** Parse `reg query` output for the `DisplayIcon` executable value. */
function registryExecutableFromQuery(output) {
  for (const rawLine of output.split(/\r?\n/u)) {
    const match = /^\s*DisplayIcon\s+REG_SZ\s+(.*?)\s*$/u.exec(rawLine)
    if (match === null) continue
    const executable = normalizeRegistryExecutable(match[1])
    if (executable !== undefined) return executable
  }
  return undefined
}

/** The `WorkBuddy.exe` under an `InstallLocation`-style registry directory. */
function registryInstallLocationFromQuery(output) {
  for (const rawLine of output.split(/\r?\n/u)) {
    const match = /^\s*InstallLocation\s+REG_SZ\s+(.*?)\s*$/u.exec(rawLine)
    if (match === null) continue
    const directory = stripRegistryQuotes(match[1])
    if (directory === undefined || directory === '') continue
    return win32.join(directory, APP_EXECUTABLE_NAMES[0])
  }
  return undefined
}

/** The executable path WorkBuddy's own uninstall registration points at. */
function windowsRegistryAppExecutable() {
  for (const root of [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    const listing = queryRegistry(['query', root, '/s', '/f', 'WorkBuddy', '/t', 'REG_SZ'])
    if (listing === undefined) continue
    const executable = registryExecutableFromQuery(listing)
    if (executable !== undefined) return executable
    const fromDirectory = registryInstallLocationFromQuery(listing)
    if (fromDirectory !== undefined) return fromDirectory
  }
  return undefined
}

/** Candidate paths of the WorkBuddy desktop executable, in probe order. */
export function workbuddyAppExecutableCandidates(platform = process.platform, home = homedir(), env = process.env) {
  const candidates = [env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()]
  if (platform === 'win32') {
    const bases = [env['LOCALAPPDATA']?.trim(), env['ProgramFiles']?.trim(), env['ProgramFiles(x86)']?.trim()]
    for (const base of bases) {
      if (base === undefined || base === '') continue
      for (const subdirectory of WINDOWS_APP_SUBDIRECTORIES) for (const name of APP_EXECUTABLE_NAMES) candidates.push(win32.join(base, ...subdirectory, name))
    }
  } else if (platform === 'darwin') {
    for (const name of MACOS_APP_BUNDLE_NAMES) {
      candidates.push(macosBundleExecutable(join('/Applications', name)), macosBundleExecutable(join(home, 'Applications', name)))
    }
  }
  return candidates.filter((candidate) => candidate !== undefined && candidate !== '')
}

/** The first candidate that exists as a file, or undefined. */
export function findWorkbuddyAppExecutable(platform = process.platform, home = homedir(), env = process.env) {
  for (const candidate of workbuddyAppExecutableCandidates(platform, home, env)) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 下一个候选
    }
  }
  if (platform === 'win32') {
    const fromRegistry = windowsRegistryAppExecutable()
    if (fromRegistry !== undefined) {
      try {
        if (existsSync(fromRegistry)) return fromRegistry
      } catch {
        // 落到 undefined
      }
    }
  }
  return undefined
}

/**
 * Ask the installed desktop app for its key payload by running its own binary
 * as plain Node (`ELECTRON_RUN_AS_NODE`) and calling the native binding.
 */
export function fetchAtRestKeyPayload(executable) {
  return new Promise((resolve, reject) => {
    execFile(executable, ["-e", "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: KEY_FETCH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1_048_576,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${String(stderr).trim() || error.message})`))
        return
      }
      const payload = String(stdout).trim()
      if (payload === '') {
        reject(new Error('workbuddy: the desktop app returned an empty at-rest key payload'))
        return
      }
      resolve(payload)
    })
  })
}

/** Process-lifetime cache of the derived key; never persisted. */
let cachedKey
let inflightKey

/**
 * The desktop app's at-rest field key, or undefined when it cannot be obtained.
 * Cached after the first success so the app is spawned at most once per process.
 */
export function readAtRestKey() {
  if (cachedKey !== undefined) return Promise.resolve(cachedKey)
  inflightKey ??= (async () => {
    const executable = findWorkbuddyAppExecutable()
    if (executable === undefined) return undefined
    const key = deriveAtRestKey(await fetchAtRestKeyPayload(executable))
    cachedKey = key
    return key
  })().finally(() => {
    inflightKey = undefined
  })
  return inflightKey
}

/** Drop the cached key; tests and diagnostics only. */
export function clearAtRestKeyCache() {
  cachedKey = undefined
  inflightKey = undefined
}

// ---------------------------------------------------------------------------
// 文档解析（老插件 auth.ts 原样）
// ---------------------------------------------------------------------------

/** Marker for a credential that EXISTS but could not be decrypted. */
export const ENCRYPTED_CREDENTIAL_CODE = 'WORKBUDDY_ENCRYPTED_CREDENTIAL'

/** The user IS signed in, but the credential file cannot be read. */
export class WorkBuddyEncryptedCredentialError extends Error {
  code = ENCRYPTED_CREDENTIAL_CODE
  constructor(paths) {
    const where = paths.length > 0 ? paths.join(', ') : 'the credential file'
    super(`workbuddy: your WorkBuddy sign-in is present but encrypted, so it cannot be read (${where}). The WorkBuddy desktop app must be present to hand over its key; install it, or set ${WORKBUDDY_APP_EXECUTABLE_ENV} to its executable. Signing in again will not change this.`)
    this.name = 'WorkBuddyEncryptedCredentialError'
    this.paths = paths
  }
}

/** Whether an error reports an unreadable (encrypted) credential. */
export function isEncryptedCredentialError(value) {
  return typeof value === 'object' && value !== null && value.code === ENCRYPTED_CREDENTIAL_CODE
}

/** Resolve one string field, transparently opening the encrypted wrapper when present. */
function credentialField(value, key) {
  if (typeof value === 'string') return value
  if (!isEncryptedFieldWrapper(value)) return undefined
  if (key === undefined) return undefined
  return openEncryptedField(value, key)
}

/** An optional field: absent / non-string / unopenable all mean "unknown". */
function optionalCredentialField(value, key) {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (!isEncryptedFieldWrapper(value)) return undefined
  if (key === undefined) return undefined
  try {
    return openEncryptedField(value, key)
  } catch {
    return undefined
  }
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the nested form
 * `{"auth":{...},"account":{...}}` and the flat panel form. Returns undefined
 * when the document carries no access token.
 */
export function parseWorkBuddyAuth(text, filePath, atRestKey) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed
  let auth
  let identity
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth']
    identity = typeof document['account'] === 'object' && document['account'] !== null ? document['account'] : {}
  } else {
    auth = document
    identity = document
  }
  let accessToken
  let refreshToken
  try {
    accessToken = credentialField(auth['accessToken'], atRestKey)
    refreshToken = credentialField(auth['refreshToken'], atRestKey)
  } catch {
    return undefined
  }
  if (accessToken === undefined || accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const lastRefreshAtMs = typeof auth['lastRefreshTime'] === 'number' ? expiryToMs(auth['lastRefreshTime']) : undefined
  const enterpriseId = optionalCredentialField(identity['enterpriseId'], atRestKey)
  const nickname = optionalCredentialField(identity['nickname'], atRestKey)
  const uin = optionalCredentialField(identity['uin'], atRestKey)
  return {
    accessToken,
    refreshToken: refreshToken ?? '',
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalCredentialField(auth['domain'], atRestKey) ?? '',
    uid: optionalCredentialField(identity['uid'], atRestKey) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    ...(uin === undefined ? {} : { uin }),
    ...(lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs }),
    source: 'desktop',
    filePath,
  }
}

/** Whether a document carries any field the reader must decrypt. */
export function hasEncryptedCredentialFields(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const document = parsed
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null ? document['auth'] : document
  const identity = typeof document['account'] === 'object' && document['account'] !== null ? document['account'] : document
  return isEncryptedFieldWrapper(auth['accessToken']) || isEncryptedFieldWrapper(auth['refreshToken']) || isEncryptedFieldWrapper(identity['nickname']) || isEncryptedFieldWrapper(identity['uin']) || isEncryptedFieldWrapper(identity['uid']) || isEncryptedFieldWrapper(identity['enterpriseId']) || isEncryptedFieldWrapper(auth['domain'])
}

/** Whether text parses as JSON at all. */
function isParseableJson(text) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Probe one auth file, reporting WHY it yielded no credential. The plain read
 * is tried first; the app is asked for its key only when the document actually
 * carries encrypted wrappers.
 */
export async function probeAuthFile(path, resolveAtRestKey) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const missing = isENOENT(error)
    return {
      failure: {
        reason: missing ? 'missing' : 'unreadable',
        ...(missing ? {} : { message: error instanceof Error ? error.message : String(error) }),
      },
    }
  }
  const plain = parseWorkBuddyAuth(text, path)
  if (plain !== undefined) return { credential: plain }
  if (!hasEncryptedCredentialFields(text)) {
    return isParseableJson(text)
      ? { failure: { reason: 'invalid', message: 'no access token in the document' } }
      : { failure: { reason: 'invalid', message: 'the file is not valid JSON' } }
  }
  let key
  try {
    key = await resolveAtRestKey()
  } catch (error) {
    return { failure: { reason: 'encrypted', message: error instanceof Error ? error.message : String(error) } }
  }
  if (key === undefined) {
    return { failure: { reason: 'encrypted', message: `the credential fields are encrypted and no key was available; the WorkBuddy desktop app must be present (or set ${WORKBUDDY_APP_EXECUTABLE_ENV})` } }
  }
  const decrypted = parseWorkBuddyAuth(text, path, key)
  return decrypted === undefined
    ? { failure: { reason: 'invalid', message: 'the encrypted credential fields could not be opened with the desktop app\'s key' } }
    : { credential: decrypted }
}

/** Read one auth file, tolerating absence and unparsable content. */
export async function readAuthFile(path, resolveAtRestKey) {
  const probe = await probeAuthFile(path, resolveAtRestKey)
  return 'credential' in probe ? probe.credential : undefined
}

// ---------------------------------------------------------------------------
// 凭据 store（扫描 + 去重 + 区域过滤 + 按需刷新；不写盘）
// ---------------------------------------------------------------------------

/**
 * 只读凭据 store（老插件 WorkBuddyCredentialStore 的无 vault 移植版）。
 *
 * @param {object} options
 * @param {'cn'|'global'} [options.region] 限定可见账号的区域；缺省两区通看
 * @param {string[]} [options.authDirs] 测试注入的 auth 目录；缺省平台默认
 * @param {string} [options.desktopPath] 显式 auth 文件（WORKBUDDY_AUTH_FILE 同效）
 * @param {() => Promise<Buffer|undefined>} [options.resolveAtRestKey] 测试注入
 * @param {(credential) => Promise<object>} [options.refresh] token 刷新传输；
 *   缺省走上游 `/v2/plugin/auth/token/refresh`
 * @param {typeof fetch} [options.fetchImpl] 刷新传输的 fetch 注入
 * @param {number} [options.refreshMarginMs] 到期余量，默认 5 分钟
 */
export function createWorkBuddyCredentialStore(options = {}) {
  const region = options.region
  const refresh = options.refresh ?? ((credential) => refreshWorkBuddyToken(credential, options.fetchImpl))
  const refreshMarginMs = options.refreshMarginMs ?? 300_000
  const resolveAtRestKey = options.resolveAtRestKey ?? readAtRestKey
  const env = options.env ?? process.env
  let desktopPathOverride = options.desktopPath
  let accountId
  let inflight
  /** 刷新成功的凭据只活在这里：进程内存 overlay，绝不落盘。 */
  const refreshedById = new Map()

  /** Whether a credential's login domain belongs to this store's region. */
  function matchesRegion(domain) {
    return region === undefined || regionOf(domain) === region
  }

  /** The auth-file path candidates, in probe order. */
  function resolveDesktopCandidates() {
    const fromEnv = env[WORKBUDDY_AUTH_FILE_ENV]
    const explicit = desktopPathOverride ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return (options.authDirs ?? defaultDesktopAuthDirs(undefined, undefined, env)).map((dir) => join(dir, WORKBUDDY_LIVE_FILENAME))
  }

  /** Timestamped siblings of one auth file, newest first by filename. */
  async function backupsBeside(path) {
    const dir = dirname(path)
    const base = path.slice(dir.length + 1)
    try {
      return (await readdir(dir)).filter((name) => name !== base && name.endsWith('.info')).sort().reverse().map((name) => join(dir, name))
    } catch {
      return []
    }
  }

  /** Every auth file to scan: the live file plus the timestamped backups. */
  async function candidateFiles() {
    const fromEnv = env[WORKBUDDY_AUTH_FILE_ENV]
    const explicitPath = desktopPathOverride ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    const files = []
    if (explicitPath !== undefined) {
      files.push(explicitPath)
      for (const backup of await backupsBeside(explicitPath)) files.push(backup)
      return files
    }
    for (const dir of options.authDirs ?? defaultDesktopAuthDirs(undefined, undefined, env)) {
      const live = join(dir, WORKBUDDY_LIVE_FILENAME)
      files.push(live)
      for (const backup of await backupsBeside(live)) files.push(backup)
    }
    return files
  }

  /**
   * Read every local credential, deduplicated by account id, then overlay the
   * in-memory refreshed copies (a fresh desktop re-login rewrites the file with
   * a newer `lastRefreshTime` and drops the overlay naturally).
   */
  async function readAll() {
    const files = await candidateFiles()
    const byId = new Map()
    for (const file of files) {
      let credential
      try {
        credential = await readAuthFile(file, resolveAtRestKey)
      } catch {
        continue
      }
      if (credential === undefined || !matchesRegion(credential.domain)) continue
      const id = workbuddyAccountId(credential)
      const existing = byId.get(id)
      if (existing === undefined || isFresher(credential, existing)) byId.set(id, credential)
    }
    for (const [id, overlay] of refreshedById) {
      const existing = byId.get(id)
      if (existing === undefined) {
        if (matchesRegion(overlay.credential.domain)) byId.set(id, overlay.credential)
        continue
      }
      const fileIssuance = existing.lastRefreshAtMs ?? 0
      if (fileIssuance <= overlay.baseLastRefreshAtMs) byId.set(id, overlay.credential)
      else refreshedById.delete(id)
    }
    return Object.freeze([...byId.values()])
  }

  /** Default when no account is explicitly selected: the freshest credential. */
  function preferred(credentials) {
    if (credentials.length === 0) return undefined
    return credentials.reduce((best, credential) => isFresher(credential, best) ? credential : best)
  }

  /** Token-free account list（id/昵称/域/来源/到期时间，绝无 token）。 */
  async function accounts() {
    const credentials = await readAll()
    if (credentials.length === 0) return []
    const defaultSelected = preferred(credentials)
    return credentials.map((credential) => ({
      id: workbuddyAccountId(credential),
      accountName: credential.nickname ?? '',
      domain: credential.domain,
      source: credential.source,
      tokenExpiresAtMs: credential.expiresAtMs,
      filePath: credential.filePath,
      selected: accountId === undefined ? credential === defaultSelected : workbuddyAccountId(credential) === accountId,
    }))
  }

  /** Select an account by id; '' 恢复「跟随 App 当前登录」。 */
  function selectAccount(id) {
    accountId = id === '' ? undefined : id
    inflight = undefined
  }

  /** The freshest stored credential for the current selection, no refresh. */
  async function current() {
    const credentials = await readAll()
    if (accountId === undefined) return preferred(credentials)
    return credentials.find((credential) => workbuddyAccountId(credential) === accountId)
  }

  function needsRefresh(credential) {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + refreshMarginMs >= credential.expiresAtMs
  }

  async function refreshNow(credential) {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    try {
      const outcome = await refresh(credential)
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs: outcome.expiresInSec !== undefined ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
        ...(outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain }),
        source: 'dsh',
      }
      refreshedById.set(workbuddyAccountId(credential), {
        credential: refreshed,
        baseLastRefreshAtMs: credential.lastRefreshAtMs ?? 0,
      })
      return refreshed
    } catch (error) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`workbuddy: token refresh failed and the access token is expired (${String(error)}); open the WorkBuddy desktop app once to sign in again`)
    }
  }

  /** WHY no credential resolved, as the error to throw（失败路径才诊断）. */
  async function describeMissingCredential() {
    const encrypted = []
    for (const file of await candidateFiles()) {
      try {
        const probe = await probeAuthFile(file, resolveAtRestKey)
        if ('failure' in probe && probe.failure.reason === 'encrypted') encrypted.push(file)
      } catch {
        // 诊断本身失败不掩盖真正的错误
      }
    }
    if (encrypted.length > 0) return new WorkBuddyEncryptedCredentialError(encrypted)
    const candidates = resolveDesktopCandidates()
    const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
    return new Error(`workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app (expected ${desktop} or ${WORKBUDDY_AUTH_FILE_ENV})`)
  }

  /** The credential to send upstream: current(), refreshed on demand（单飞）. */
  async function resolve() {
    const credential = await current()
    if (credential === undefined) throw await describeMissingCredential()
    if (!needsRefresh(credential)) return credential
    inflight ??= refreshNow(credential).finally(() => {
      inflight = undefined
    })
    return inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async function status() {
    try {
      const credential = await current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
        ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
        ...(credential.domain === '' ? {} : { domain: credential.domain }),
        source: credential.source,
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  return {
    accounts,
    current,
    resolve,
    status,
    selectAccount,
    matchesRegion,
    resolveDesktopCandidates,
    setDesktopPath(path) {
      desktopPathOverride = path
      inflight = undefined
    },
  }
}
