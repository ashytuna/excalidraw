/**
 * Syncs the local scene (+ library) with a hidden copy in Google Drive
 * (appDataFolder). Browser storage stays the source of truth for the editor;
 * Drive is a mirror that's reconciled on load/focus and after local edits.
 *
 * Drive layout:
 * - `excalidraw-sync.json`: { version, scene (.excalidraw JSON w/o files),
 *   library }. `appProperties` carry hash + summary so we can compare without
 *   downloading.
 * - `file-<fileId>.json`: one per image (BinaryFileData), immutable.
 */

import {
  CaptureUpdateAction,
  getNonDeletedElements,
  hashString,
  restoreAppState,
  restoreElements,
  restoreLibraryItems,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import { debounce, isTestEnv } from "@excalidraw/common";
import { isInitializedImageElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";

import { appJotaiStore, atom } from "../app-jotai";
import { LibraryIndexedDBAdapter } from "../data/LocalData";

import {
  DriveNeedsAuthError,
  deleteFile,
  downloadFile,
  listAppDataFiles,
  uploadFile,
} from "./api";
import {
  getAccessToken,
  isDriveSyncAvailable,
  requestAccessToken,
  revokeAccess,
} from "./auth";
import { decideSync } from "./reconcile";

import type { DriveFile } from "./api";

const SYNC_FILE_NAME = "excalidraw-sync.json";
const IMAGE_FILE_PREFIX = "file-";
const META_STORAGE_KEY = "excalidraw-gdrive";
const PUSH_DEBOUNCE_MS = 3000;
const FOCUS_CHECK_MIN_INTERVAL_MS = 15 * 1000;

// -----------------------------------------------------------------------------
// state exposed to UI

export type DriveSyncStatus =
  | { type: "disconnected" }
  | { type: "needs-auth" }
  | { type: "syncing" }
  | { type: "synced"; at: number }
  | { type: "conflict" }
  | { type: "error"; message: string };

export type SnapshotSummary = {
  /** last edit time (max element.updated) */
  updatedAt: number;
  elementCount: number;
  libraryCount: number;
  device: string | null;
};

export type DriveConflict = {
  local: SnapshotSummary;
  remote: SnapshotSummary;
  /** for previews */
  localElements: readonly NonDeletedExcalidrawElement[];
  remoteElements: readonly NonDeletedExcalidrawElement[];
  remoteViewBackgroundColor: string | undefined;
};

export const driveSyncStatusAtom = atom<DriveSyncStatus>({
  type: "disconnected",
});
export const driveConflictAtom = atom<DriveConflict | null>(null);

const setStatus = (status: DriveSyncStatus) =>
  appJotaiStore.set(driveSyncStatusAtom, status);

// -----------------------------------------------------------------------------
// persisted meta (shared between tabs)

type SyncMeta = {
  connected: boolean;
  lastSyncedHash: string | null;
  lastSyncedAt: number | null;
};

const readMeta = (): SyncMeta => {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return { connected: false, lastSyncedHash: null, lastSyncedAt: null };
};

const writeMeta = (patch: Partial<SyncMeta>) => {
  try {
    localStorage.setItem(
      META_STORAGE_KEY,
      JSON.stringify({ ...readMeta(), ...patch }),
    );
  } catch (error) {
    console.error(error);
  }
};

// -----------------------------------------------------------------------------
// snapshots

type RemoteSyncData = {
  version: 1;
  scene: ImportedDataState;
  library: LibraryItems;
};

type LocalSnapshot = {
  content: string;
  hash: string;
  elements: readonly NonDeletedExcalidrawElement[];
  summary: SnapshotSummary;
};

const hashContent = (content: string) =>
  `${hashString(content)}-${content.length}`;

const getDeviceName = () => {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
    ? "Firefox"
    : /Chrome\//.test(ua)
    ? "Chrome"
    : /Safari\//.test(ua)
    ? "Safari"
    : "Browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Windows/.test(ua)
    ? "Windows"
    : /Mac OS/.test(ua)
    ? "macOS"
    : /Linux/.test(ua)
    ? "Linux"
    : "";
  return os ? `${browser} · ${os}` : browser;
};

const getLastUpdated = (elements: readonly ExcalidrawElement[]) =>
  elements.reduce((max, element) => Math.max(max, element.updated || 0), 0);

const getReferencedFileIds = (elements: readonly ExcalidrawElement[]) =>
  new Set(
    elements.filter(isInitializedImageElement).map((element) => element.fileId),
  );

const imageFileName = (id: FileId) => `${IMAGE_FILE_PREFIX}${id}.json`;

const summaryFromAppProperties = (file: DriveFile): SnapshotSummary => ({
  updatedAt: Number(file.appProperties?.updatedAt) || 0,
  elementCount: Number(file.appProperties?.elements) || 0,
  libraryCount: Number(file.appProperties?.library) || 0,
  device: file.appProperties?.device || null,
});

// -----------------------------------------------------------------------------

class DriveSyncManager {
  private api: ExcalidrawImperativeAPI | null = null;
  private running: Promise<void> | null = null;
  private lastFocusCheck = 0;
  /** remote data kept while the conflict dialog is open */
  private pendingRemote: { file: DriveFile; data: RemoteSyncData } | null =
    null;

  isAvailable = isDriveSyncAvailable;

  isConnected = () => readMeta().connected;

  /** called once the editor & initial scene are ready */
  init = (api: ExcalidrawImperativeAPI) => {
    this.api = api;
    if (!this.isAvailable() || !this.isConnected()) {
      setStatus({ type: "disconnected" });
      return;
    }
    this.check();
  };

  // --- user actions ----------------------------------------------------------

  /** must be called from a click handler (opens Google popup) */
  connect = async () => {
    try {
      await requestAccessToken({
        prompt: this.isConnected() ? "" : "select_account",
      });
    } catch (error: any) {
      console.error(error);
      if (!this.isConnected()) {
        setStatus({ type: "disconnected" });
      }
      return;
    }
    writeMeta({ connected: true });
    await this.check({ force: true });
  };

  disconnect = async () => {
    this.schedulePush.cancel();
    await revokeAccess();
    writeMeta({ connected: false, lastSyncedHash: null, lastSyncedAt: null });
    this.pendingRemote = null;
    appJotaiStore.set(driveConflictAtom, null);
    setStatus({ type: "disconnected" });
  };

  /** manual "sync now" */
  syncNow = () => this.check({ force: true });

  resolveConflict = async (choice: "local" | "remote") => {
    const pending = this.pendingRemote;
    this.pendingRemote = null;
    appJotaiStore.set(driveConflictAtom, null);
    if (choice === "local") {
      await this.run(() => this.push({ force: true }));
    } else if (pending) {
      await this.run(async () => {
        setStatus({ type: "syncing" });
        await this.applyRemote(pending.file, pending.data);
      });
    }
  };

  // --- triggers --------------------------------------------------------------

  /** hot path (every scene change): keep it cheap */
  onLocalChange = (_elements?: readonly OrderedExcalidrawElement[]) => {
    if (!this.api || !this.isConnected()) {
      return;
    }
    const status = appJotaiStore.get(driveSyncStatusAtom);
    if (status.type === "conflict" || status.type === "needs-auth") {
      return;
    }
    this.schedulePush();
  };

  /** window focus / tab visible: Drive may have been updated elsewhere */
  onFocus = () => {
    if (
      !this.api ||
      !this.isConnected() ||
      Date.now() - this.lastFocusCheck < FOCUS_CHECK_MIN_INTERVAL_MS
    ) {
      return;
    }
    // let tabSync load newer local state from other tabs first
    setTimeout(() => this.check(), 500);
  };

  flush = () => this.schedulePush.flush();

  private schedulePush = debounce(() => {
    if (document.hidden) {
      return;
    }
    this.run(async () => {
      const local = await this.getLocalSnapshot();
      // most onChange calls are selection/scroll -> content unchanged
      if (local.hash === readMeta().lastSyncedHash) {
        return;
      }
      await this.push({ local });
    });
  }, PUSH_DEBOUNCE_MS);

  // --- core ------------------------------------------------------------------

  /** serializes operations so we never push & pull concurrently */
  private run = async (op: () => Promise<void>) => {
    while (this.running) {
      await this.running.catch(() => {});
    }
    this.running = op()
      .catch((error) => this.handleError(error))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  };

  private handleError = (error: unknown) => {
    if (error instanceof DriveNeedsAuthError) {
      setStatus({ type: "needs-auth" });
      return;
    }
    console.error("[gdrive]", error);
    setStatus({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  };

  check = (opts: { force?: boolean } = {}) => {
    if (!this.api || !this.isConnected() || isTestEnv()) {
      return Promise.resolve();
    }
    const status = appJotaiStore.get(driveSyncStatusAtom);
    if (status.type === "conflict" && !opts.force) {
      return Promise.resolve();
    }
    if (!getAccessToken()) {
      setStatus({ type: "needs-auth" });
      return Promise.resolve();
    }
    this.lastFocusCheck = Date.now();
    this.schedulePush.cancel();
    return this.run(() => this.reconcile());
  };

  private async getLocalSnapshot(): Promise<LocalSnapshot> {
    const api = this.api!;
    const allElements = api.getSceneElementsIncludingDeleted();
    const elements = getNonDeletedElements(allElements);
    const library = (await LibraryIndexedDBAdapter.load())?.libraryItems || [];
    // files are synced separately, scene only references them by id
    const sceneJSON = serializeAsJSON(elements, api.getAppState(), {}, "local");
    const content = `{"version":1,"scene":${sceneJSON},"library":${JSON.stringify(
      library,
    )}}`;
    return {
      content,
      hash: hashContent(content),
      elements,
      summary: {
        updatedAt: getLastUpdated(allElements),
        elementCount: elements.length,
        libraryCount: library.length,
        device: getDeviceName(),
      },
    };
  }

  private async reconcile() {
    setStatus({ type: "syncing" });
    const files = await listAppDataFiles();
    const syncFile = files.find((file) => file.name === SYNC_FILE_NAME) || null;
    const local = await this.getLocalSnapshot();

    const decision = decideSync({
      localHash: local.hash,
      remoteHash: syncFile ? syncFile.appProperties?.hash ?? "" : null,
      lastSyncedHash: readMeta().lastSyncedHash,
      localIsEmpty:
        local.summary.elementCount === 0 && local.summary.libraryCount === 0,
    });

    switch (decision) {
      case "in-sync":
        await this.uploadMissingImages(files, local.elements);
        this.markSynced(local.hash);
        return;
      case "push":
        return this.push({ files, local });
      case "pull": {
        const data = await this.downloadSyncData(syncFile!);
        return this.applyRemote(syncFile!, data);
      }
      case "conflict": {
        const data = await this.downloadSyncData(syncFile!);
        return this.openConflict(syncFile!, data, local);
      }
    }
  }

  private async push(
    opts: {
      force?: boolean;
      files?: DriveFile[];
      local?: LocalSnapshot;
    } = {},
  ) {
    setStatus({ type: "syncing" });
    const files = opts.files || (await listAppDataFiles());
    const local = opts.local || (await this.getLocalSnapshot());
    const syncFile = files.find((file) => file.name === SYNC_FILE_NAME) || null;
    const remoteHash = syncFile?.appProperties?.hash ?? null;
    const { lastSyncedHash } = readMeta();

    // somebody else pushed since our last sync -> let the user decide
    if (
      !opts.force &&
      syncFile &&
      remoteHash !== local.hash &&
      remoteHash !== lastSyncedHash
    ) {
      const data = await this.downloadSyncData(syncFile);
      return this.openConflict(syncFile, data, local);
    }

    // images first, so the scene on Drive never references missing files
    await this.uploadMissingImages(files, local.elements);

    if (remoteHash !== local.hash) {
      await uploadFile({
        fileId: syncFile?.id ?? null,
        name: SYNC_FILE_NAME,
        content: local.content,
        appProperties: {
          hash: local.hash,
          updatedAt: String(local.summary.updatedAt),
          elements: String(local.summary.elementCount),
          library: String(local.summary.libraryCount),
          device: local.summary.device || "",
        },
      });
    }
    this.markSynced(local.hash);

    // drop images no longer used by the scene
    const referenced = getReferencedFileIds(local.elements);
    await Promise.all(
      files
        .filter(
          (file) =>
            file.name.startsWith(IMAGE_FILE_PREFIX) &&
            !referenced.has(
              file.name.slice(
                IMAGE_FILE_PREFIX.length,
                -".json".length,
              ) as FileId,
            ),
        )
        .map((file) => deleteFile(file.id)),
    );
  }

  private async uploadMissingImages(
    files: DriveFile[],
    elements: readonly ExcalidrawElement[],
  ) {
    const existing = new Set(files.map((file) => file.name));
    const localFiles = this.api!.getFiles();
    const missing = [...getReferencedFileIds(elements)].filter(
      (id) => !existing.has(imageFileName(id)) && localFiles[id],
    );
    for (const id of missing) {
      const { lastRetrieved, ...fileData } = localFiles[id];
      await uploadFile({
        fileId: null,
        name: imageFileName(id),
        content: JSON.stringify(fileData),
      });
    }
  }

  private async downloadSyncData(file: DriveFile): Promise<RemoteSyncData> {
    return JSON.parse(await downloadFile(file.id));
  }

  private async applyRemote(file: DriveFile, data: RemoteSyncData) {
    const api = this.api!;
    const elements = restoreElements(data.scene.elements, null, {
      repairBindings: true,
    });

    // fetch images we don't have locally
    const localFiles = api.getFiles();
    const missingIds = [...getReferencedFileIds(elements)].filter(
      (id) => !localFiles[id],
    );
    if (missingIds.length) {
      const remoteFiles = await listAppDataFiles();
      const byName = new Map(remoteFiles.map((f) => [f.name, f]));
      const images: BinaryFileData[] = [];
      for (const id of missingIds) {
        const remoteImage = byName.get(imageFileName(id));
        if (remoteImage) {
          images.push(JSON.parse(await downloadFile(remoteImage.id)));
        }
      }
      if (images.length) {
        api.addFiles(images);
      }
    }

    api.updateScene({
      elements,
      appState: restoreAppState(data.scene.appState, api.getAppState()),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    // undoing into the replaced scene would be confusing
    api.history.clear();
    await api.updateLibrary({
      libraryItems: restoreLibraryItems(data.library, "unpublished"),
      merge: false,
    });

    // local content now equals Drive's; any normalization diff from restore
    // will be pushed as a regular local change
    this.markSynced(file.appProperties?.hash ?? null);
  }

  private openConflict(
    file: DriveFile,
    data: RemoteSyncData,
    local: LocalSnapshot,
  ) {
    this.pendingRemote = { file, data };
    appJotaiStore.set(driveConflictAtom, {
      local: local.summary,
      remote: summaryFromAppProperties(file),
      localElements: local.elements,
      remoteElements: getNonDeletedElements(
        restoreElements(data.scene.elements, null),
      ),
      remoteViewBackgroundColor: data.scene.appState?.viewBackgroundColor,
    });
    setStatus({ type: "conflict" });
  }

  private markSynced(hash: string | null) {
    const at = Date.now();
    writeMeta({ lastSyncedHash: hash, lastSyncedAt: at });
    setStatus({ type: "synced", at });
  }
}

export const DriveSync = new DriveSyncManager();
