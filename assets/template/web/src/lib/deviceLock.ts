// The native biometric lock (BiometricPrompt / LocalAuthentication) as WebAuthn with the phone's own
// unlock: fingerprint, face or PIN. Needs HTTPS and a host name (an IP address can't hold a passkey).

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

export async function deviceLockAvailable(): Promise<boolean> {
  try {
    return window.isSecureContext && !!window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/** Asks for fingerprint or PIN once and returns the credential to use for unlocking. */
export async function registerDeviceLock(): Promise<string | null> {
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: random(32),
        rp: { name: '__APP_NAME__', id: location.hostname },
        user: { id: random(16), name: '__APP_ID__', displayName: '__APP_NAME__' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60_000,
      },
    }) as PublicKeyCredential | null
    return credential ? b64(credential.rawId) : null
  } catch {
    return null
  }
}

export async function unlockWithDevice(credential: string | null): Promise<boolean> {
  if (!credential || !(await deviceLockAvailable())) return true
  try {
    const result = await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        allowCredentials: [{ type: 'public-key', id: unb64(credential) }],
        userVerification: 'required',
        timeout: 60_000,
      },
    })
    return result != null
  } catch {
    return false
  }
}

