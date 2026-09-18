// AES-256-GCM Verschluesselung fuer nutzereigene API-Keys (FMP/Claude) -
// siehe user_api_keys-Migration. Der Schluessel kommt aus dem Function-
// Secret API_KEY_ENCRYPTION_SECRET (32 Byte, base64), liegt NIE in der DB
// und wird nie an den Client zurueckgegeben.
//
// Ehrliche Einordnung der Schutzwirkung: Das schuetzt wirksam gegen einen
// REINEN DB-Kompromiss (Leak, Backup, SQL-Injection-Lesezugriff,
// versehentlich zu weit gefasste RLS-Policy) - ohne das Function-Secret
// sind die Ciphertexts wertlos. Es schuetzt NICHT gegen einen vollstaendigen
// Kompromiss dieses Supabase-Projekts selbst (wer Service-Role-Key +
// Function-Secrets hat, kommt ohnehin an beides). Das ist keine Abkuerzung,
// sondern eine unvermeidbare Eigenschaft jeder Architektur, in der der
// Server den Key aktiv im Namen des Nutzers gegenueber FMP/Claude verwendet
// (kein Zero-Knowledge-Design moeglich, ohne dass der Client selbst die
// externen API-Aufrufe macht - das waere ein grundlegend anderer Aufbau).
const RAW_SECRET = Deno.env.get("API_KEY_ENCRYPTION_SECRET")!;

async function getCryptoKey(): Promise<CryptoKey> {
  const keyBytes = Uint8Array.from(atob(RAW_SECRET), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipherBuf))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

export async function decryptSecret(ciphertext: string, ivB64: string): Promise<string> {
  const key = await getCryptoKey();
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const cipherBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  return new TextDecoder().decode(plainBuf);
}
