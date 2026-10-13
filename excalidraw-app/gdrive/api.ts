/**
 * Thin Drive v3 REST wrapper, scoped to the (hidden) appDataFolder.
 */

import { getAccessToken, invalidateAccessToken } from "./auth";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,version,modifiedTime,appProperties";

export type DriveFile = {
  id: string;
  name: string;
  version: string;
  modifiedTime: string;
  appProperties?: Record<string, string>;
};

/** thrown when there's no valid token -> UI should ask user to reconnect */
export class DriveNeedsAuthError extends Error {
  constructor() {
    super("Google Drive authorization required");
  }
}

export class DriveRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const request = async (url: string, init: RequestInit = {}) => {
  const token = getAccessToken();
  if (!token) {
    throw new DriveNeedsAuthError();
  }
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    invalidateAccessToken();
    throw new DriveNeedsAuthError();
  }
  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).error?.message || message;
    } catch {}
    throw new DriveRequestError(response.status, message);
  }
  return response;
};

export const listAppDataFiles = async (): Promise<DriveFile[]> => {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: "1000",
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const data = await (await request(`${API}/files?${params}`)).json();
    files.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
};

export const downloadFile = async (fileId: string): Promise<string> => {
  const response = await request(
    `${API}/files/${encodeURIComponent(fileId)}?alt=media`,
  );
  return response.text();
};

const multipartBody = (metadata: object, content: string) => {
  const boundary = `excalidraw-${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;
  return {
    body,
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  };
};

/** creates the file when `fileId` is null, otherwise overwrites its content */
export const uploadFile = async (opts: {
  fileId: string | null;
  name: string;
  content: string;
  appProperties?: Record<string, string>;
}): Promise<DriveFile> => {
  const metadata = opts.fileId
    ? { appProperties: opts.appProperties }
    : {
        name: opts.name,
        parents: ["appDataFolder"],
        appProperties: opts.appProperties,
      };
  const { body, headers } = multipartBody(metadata, opts.content);
  const url = opts.fileId
    ? `${UPLOAD_API}/files/${encodeURIComponent(
        opts.fileId,
      )}?uploadType=multipart&fields=${FILE_FIELDS}`
    : `${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`;

  const response = await request(url, {
    method: opts.fileId ? "PATCH" : "POST",
    headers,
    body,
  });
  return response.json();
};

export const deleteFile = async (fileId: string) => {
  try {
    await request(`${API}/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
    });
  } catch (error) {
    // already gone
    if (!(error instanceof DriveRequestError && error.status === 404)) {
      throw error;
    }
  }
};
