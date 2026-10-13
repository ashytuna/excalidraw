/**
 * Google Identity Services (token model) for a client-only app.
 *
 * There is no refresh token: access tokens live ~1h and a new one must be
 * requested through the GIS popup, which browsers only allow from a user
 * gesture. So an expired token on page load means "needs re-auth" until the
 * user clicks; we never try to open the popup on our own.
 */

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const TOKEN_STORAGE_KEY = "excalidraw-gdrive-token";
// treat tokens as expired a bit early so in-flight requests don't 401
const EXPIRY_MARGIN_MS = 60 * 1000;

export const GOOGLE_CLIENT_ID = import.meta.env.VITE_APP_GOOGLE_CLIENT_ID || "";

export const isDriveSyncAvailable = () => !!GOOGLE_CLIENT_ID;

type StoredToken = { accessToken: string; expiresAt: number };

// minimal typings of the GIS bits we use
type TokenResponse = {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
};
type TokenClient = {
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type: string; message?: string }) => void;
  requestAccessToken: (overrides?: { prompt?: string }) => void;
};
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: {
              type: string;
              message?: string;
            }) => void;
          }) => TokenClient;
          revoke: (token: string, done?: () => void) => void;
        };
      };
    };
  }
}

export class DriveAuthError extends Error {}

let gisPromise: Promise<void> | null = null;

const loadGIS = () => {
  if (!gisPromise) {
    gisPromise = new Promise<void>((resolve, reject) => {
      if (window.google?.accounts?.oauth2) {
        return resolve();
      }
      const script = document.createElement("script");
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisPromise = null;
        reject(new DriveAuthError("Failed to load Google Identity Services"));
      };
      document.head.appendChild(script);
    });
  }
  return gisPromise;
};

let tokenClient: TokenClient | null = null;

const readStoredToken = (): StoredToken | null => {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredToken) : null;
  } catch {
    return null;
  }
};

const storeToken = (token: StoredToken | null) => {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch (error) {
    console.error(error);
  }
};

/** valid (non-expired) access token, or null if the user must re-auth */
export const getAccessToken = (): string | null => {
  const token = readStoredToken();
  if (token && token.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return token.accessToken;
  }
  return null;
};

/** drops the token so the next request asks the user again (e.g. after 401) */
export const invalidateAccessToken = () => storeToken(null);

/**
 * Opens the Google popup. Must be called from a user gesture (click).
 * `prompt: ""` skips the account chooser/consent if already granted.
 */
export const requestAccessToken = async (
  opts: { prompt?: "" | "consent" | "select_account" } = {},
): Promise<string> => {
  await loadGIS();

  return new Promise<string>((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google!.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: () => {},
      });
    }
    tokenClient.callback = (response) => {
      if (response.error || !response.access_token) {
        reject(
          new DriveAuthError(
            response.error_description || response.error || "auth failed",
          ),
        );
        return;
      }
      storeToken({
        accessToken: response.access_token,
        expiresAt: Date.now() + Number(response.expires_in || 3600) * 1000,
      });
      resolve(response.access_token);
    };
    // popup closed / blocked
    tokenClient.error_callback = (error) => {
      reject(new DriveAuthError(error.message || error.type));
    };
    tokenClient.requestAccessToken({ prompt: opts.prompt ?? "" });
  });
};

export const revokeAccess = async () => {
  const token = readStoredToken();
  storeToken(null);
  if (token) {
    try {
      await loadGIS();
      window.google?.accounts.oauth2.revoke(token.accessToken);
    } catch (error) {
      console.warn(error);
    }
  }
};
