// Vendored from @earendil-works/pi-ai (packages/ai/src/utils/oauth/pkce.ts),
// by way of procway-code (ai-agent/src/auth/oauth/pkce.mjs).
// Copyright (c) 2025 Mario Zechner — MIT. See LICENSE-pi-ai.md in this directory.
//
// 変更点: なし（procway-code の .mjs 版をそのまま）。

function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** PKCE の verifier / challenge。どちらも 43 文字の base64url。 */
export async function generatePKCE() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));

  return { verifier, challenge };
}
