const enc = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const toB64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export const sha256 = (s: string) => crypto.subtle.digest('SHA-256', enc.encode(s));

export const pkceChallenge = async (verifier: string) => b64url(await sha256(verifier));

export async function sameSecret(a: string, b: string) {
  return crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));
}

function required(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function aesKey(secret: string) {
  const base = await crypto.subtle.importKey('raw', enc.encode(required('TOKEN_KEY', secret)), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: enc.encode('superdoctor-posting tokens v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypts JSON. `rowId` is bound in, so a value copied to another row will not open. */
export async function seal(secret: string, rowId: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(rowId) },
    await aesKey(secret),
    enc.encode(JSON.stringify(value))
  );
  return `${toB64(iv)}.${toB64(new Uint8Array(data))}`;
}

export async function open<T>(secret: string, rowId: string, sealed: string): Promise<T> {
  const [iv, data] = sealed.split('.') as [string, string];
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode(rowId) },
    await aesKey(secret),
    fromB64(data)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw', enc.encode(required('MEDIA_SIGN_KEY', secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

export async function sign(secret: string, value: string) {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value)));
}

export async function verify(secret: string, value: string, sig: string) {
  if (!/^[\w-]{43}$/.test(sig)) return false;
  return crypto.subtle.verify(
    'HMAC', await hmacKey(secret), fromB64(sig.replace(/-/g, '+').replace(/_/g, '/')), enc.encode(value)
  );
}
