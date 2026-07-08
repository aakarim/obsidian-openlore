import { requestUrl } from "obsidian";

/** The custom-scheme callback Obsidian registers for the OAuth redirect. */
export const REDIRECT_URI = "obsidian://openlore-auth";

/** Standard OAuth token response from `POST /oauth/token`. */
export interface TokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
}

/** A completed sign-in: tokens plus the decoded identity/expiry. */
export interface Session {
	accessToken: string;
	refreshToken: string;
	/** Access-token expiry as epoch ms. */
	expiresAt: number;
	/** `sub` claim from the access token. */
	identity: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier/challenge pair (RFC 7636, S256). */
export interface Pkce {
	verifier: string;
	challenge: string;
}

/** Generate a PKCE verifier and its S256 challenge. */
export async function createPkce(): Promise<Pkce> {
	const raw = new Uint8Array(32);
	crypto.getRandomValues(raw);
	const verifier = base64UrlEncode(raw);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier)
	);
	return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

/** A random URL-safe token, used for the OAuth `state` parameter. */
export function randomState(): string {
	const raw = new Uint8Array(16);
	crypto.getRandomValues(raw);
	return base64UrlEncode(raw);
}

function trimUrl(serverUrl: string): string {
	return serverUrl.trim().replace(/\/+$/, "");
}

/** Build the `GET /authorize` URL that kicks off the passkey login ceremony. */
export function buildAuthorizeUrl(
	serverUrl: string,
	state: string,
	challenge: string
): string {
	const u = new URL(`${trimUrl(serverUrl)}/authorize`);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("redirect_uri", REDIRECT_URI);
	u.searchParams.set("state", state);
	u.searchParams.set("code_challenge", challenge);
	u.searchParams.set("code_challenge_method", "S256");
	u.searchParams.set("scope", "full");
	return u.toString();
}

/** Decode a JWT payload (no verification — the server verifies). */
function decodeClaims(token: string): Record<string, unknown> {
	const part = token.split(".")[1];
	if (!part) return {};
	const padded = part.replace(/-/g, "+").replace(/_/g, "/");
	try {
		return JSON.parse(atob(padded));
	} catch {
		return {};
	}
}

function toSession(t: TokenResponse, prevRefresh = ""): Session {
	const claims = decodeClaims(t.access_token);
	return {
		accessToken: t.access_token,
		refreshToken: t.refresh_token || prevRefresh,
		expiresAt: Date.now() + Math.max(0, t.expires_in) * 1000,
		identity: typeof claims.sub === "string" ? claims.sub : "",
	};
}

async function postToken(
	serverUrl: string,
	form: Record<string, string>
): Promise<TokenResponse> {
	const body = new URLSearchParams(form).toString();
	const res = await requestUrl({
		url: `${trimUrl(serverUrl)}/oauth/token`,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		throw: false,
	});
	if (res.status < 200 || res.status >= 300) {
		const desc =
			res.json?.error_description || res.json?.error || res.text || "unknown";
		throw new Error(`token endpoint ${res.status}: ${desc}`);
	}
	return res.json as TokenResponse;
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCode(
	serverUrl: string,
	code: string,
	verifier: string
): Promise<Session> {
	const t = await postToken(serverUrl, {
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
	});
	return toSession(t);
}

/** Redeem a refresh token for a fresh access token (rotates the refresh token). */
export async function refreshSession(
	serverUrl: string,
	refreshToken: string
): Promise<Session> {
	const t = await postToken(serverUrl, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	return toSession(t, refreshToken);
}
