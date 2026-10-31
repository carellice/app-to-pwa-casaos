import { useSyncExternalStore } from 'react'
import { api } from './api.ts'

// One store for the whole app, read with useStore(selector). Data comes from the server
// (GET /api/state) and is cached per account on the device, so the app opens instantly and
// works offline with the last data seen.

// TODO(port): the shape returned by the server's state() (shared/model.ts).
export type AppState = { items: unknown[] }

// --- device settings: per phone and per account, like the native DataStore / UserDefaults ----

export type ThemeMode = 'SYSTEM' | 'LIGHT' | 'DARK'

export type Settings = {
  theme: ThemeMode
  /** WebAuthn credential used as the fingerprint lock, null when the lock is off. */
  lockCredential: string | null
  remindersEnabled: boolean
  onboarded: boolean
  // TODO(port): every other per-device preference of the native app (accent color...).
}

// Every account keeps its own settings and data cache, so a shared tablet can switch between them.
const LAST_USER_KEY = '__APP_ID__.user'
const settingsKey = (user: string) => `__APP_ID__.settings.${user.toLowerCase()}`
const cacheKey = (user: string) => `__APP_ID__.cache.${user.toLowerCase()}`

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function write(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* too big or private mode */ }
}

let currentUser = read(LAST_USER_KEY) ?? ''

function loadSettings(user: string): Settings {
  const defaults: Settings = { theme: 'SYSTEM', lockCredential: null, remindersEnabled: false, onboarded: false }
  try {
    return { ...defaults, ...JSON.parse(read(settingsKey(user)) ?? '{}') }
  } catch {
    return defaults
  }
}

// --- store -----------------------------------------------------------------------------------

type Store = {
  data: AppState | null
  revision: number
  settings: Settings
  loadError: string | null
}

function cachedData(user: string): { data: AppState; revision: number } | null {
  try {
    const raw = read(cacheKey(user))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

let store: Store = {
  data: currentUser ? cachedData(currentUser)?.data ?? null : null,
  revision: -1,
  settings: loadSettings(currentUser),
  loadError: null,
}
const listeners = new Set<() => void>()

function set(patch: Partial<Store>) {
  store = { ...store, ...patch }
  listeners.forEach((l) => l())
}

export function useStore<T>(selector: (s: Store) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => selector(store),
  )
}

export const getStore = () => store

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...store.settings, ...patch }
  write(settingsKey(currentUser), JSON.stringify(settings))
  set({ settings })
}

/** Switches to the settings and data of [user], after logging in or when the app opens. */
export function setUser(user: string) {
  if (user.toLowerCase() === currentUser.toLowerCase() && store.data) {
    currentUser = user
    write(LAST_USER_KEY, user)
    return
  }
  currentUser = user
  write(LAST_USER_KEY, user)
  set({ data: cachedData(user)?.data ?? null, revision: -1, settings: loadSettings(user), loadError: null })
}

/** Forgets the data of the account that just left this device (deleted account). */
export function forgetUser(user: string) {
  write(settingsKey(user), null)
  write(cacheKey(user), null)
}

export const loggedUser = () => currentUser

// --- data ------------------------------------------------------------------------------------

type StateResponse = ({ unchanged: true } | AppState) & { revision: number }

let loading: Promise<void> | null = null

/** Reloads the data when it changed on the server (another phone, a background job...). */
export function refresh(force = false): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    try {
      const since = force || !store.data ? '' : `?since=${store.revision}`
      const result = await api<StateResponse>(`/api/state${since}`)
      if ('unchanged' in result) return
      const { revision, ...data } = result
      set({ data: data as AppState, revision, loadError: null })
      write(cacheKey(currentUser), JSON.stringify({ data, revision }))
    } catch (e) {
      set({ loadError: (e as Error).message })
    } finally {
      loading = null
    }
  })()
  return loading
}

/** Every write goes to the server, then the data is reloaded. */
export async function mutate<T>(work: () => Promise<T>): Promise<T> {
  const result = await work()
  await refresh(true)
  return result
}

// TODO(port): actions, one per native repository write. Deletes are optimistic, like on the phone:
// export const actions = {
//   saveItem: (item: Item) => mutate(() => api<Item>('/api/items', { method: 'POST', json: item })),
//   deleteItem: (item: Item) => {
//     if (store.data) set({ data: { ...store.data, items: store.data.items.filter((i) => i.id !== item.id) } })
//     return mutate(() => api('/api/items/' + item.id, { method: 'DELETE' }))
//   },
// }

// Keep in step with the other devices.
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh() })
  setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 30_000)
}
