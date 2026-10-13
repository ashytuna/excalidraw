import {
  MainMenu,
  exportToSvg,
  serializeAsJSON,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { createIcon } from "@excalidraw/excalidraw/components/icons";
import { fileSave } from "@excalidraw/excalidraw/data/filesystem";
import { MIME_TYPES } from "@excalidraw/common";
import clsx from "clsx";
import React, { useEffect, useRef, useState } from "react";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { atom, useAtom, useAtomValue } from "../app-jotai";

import { DriveSync, driveConflictAtom, driveSyncStatusAtom } from "./sync";

import "./DriveSyncUI.scss";

import type { DriveSyncStatus, SnapshotSummary } from "./sync";

// tabler icons
const tablerIconProps = {
  width: 24,
  height: 24,
  fill: "none",
  strokeWidth: 2,
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const cloudIcon = createIcon(
  <path d="M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878" />,
  tablerIconProps,
);
const cloudCheckIcon = createIcon(
  <>
    <path d="M11 18.004h-4.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.388 0 2.585 .82 3.138 2.007" />
    <path d="M15 19l2 2l4 -4" />
  </>,
  tablerIconProps,
);
const cloudOffIcon = createIcon(
  <>
    <path d="M9.58 5.548c.24 -.11 .492 -.207 .752 -.286c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 .957 -.383 1.824 -1.003 2.454m-2.997 1.033h-11.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.13 -.582 .37 -1.128 .7 -1.62" />
    <path d="M3 3l18 18" />
  </>,
  tablerIconProps,
);
const cloudUpIcon = createIcon(
  <>
    <path d="M12 18.004h-5.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.38 0 2.57 .811 3.128 1.986" />
    <path d="M19 22v-6" />
    <path d="M22 19l-3 -3l-3 3" />
  </>,
  tablerIconProps,
);
const cloudAlertIcon = createIcon(
  <>
    <path d="M12 18.004h-5.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.38 0 2.57 .811 3.128 1.986" />
    <path d="M19 16v3" />
    <path d="M19 22v.01" />
  </>,
  tablerIconProps,
);

const isConflictDialogOpenAtom = atom(true);

const strings = {
  menuConnect: "Sync with Google Drive",
  menuReconnect: "Reconnect Google Drive",
  menuSyncNow: "Sync to Drive now",
  menuDisconnect: "Disconnect Google Drive",
  statusDisconnected: "Not synced",
  statusNeedsAuth: "Drive: sign in again",
  statusSyncing: "Syncing…",
  statusSynced: "Synced to Drive",
  statusConflict: "Drive: choose a version",
  statusError: "Drive sync error",
  conflictTitle: "Drive copy differs from this device",
  conflictDesc:
    "The drawing saved in Google Drive is different from the one on this device. Choose which one to keep — the other will be overwritten.",
  local: "This device",
  remote: "Google Drive",
  lastEdited: "Last edited",
  elements: "Elements",
  libraryItems: "Library items",
  device: "Saved from",
  useLocal: "Keep this device's",
  useRemote: "Use Drive's",
  backupThenRemote: "Download this device's copy, then use Drive's",
  never: "—",
  disconnectConfirm:
    "Stop syncing with Google Drive? Your drawing stays on this device and the copy in Drive is kept.",
};

type DriveStrings = typeof strings;

const statusView = (
  status: DriveSyncStatus,
  s: DriveStrings,
): { icon: React.ReactNode; label: string; tone?: "warning" | "danger" } => {
  switch (status.type) {
    case "disconnected":
      return { icon: cloudOffIcon, label: s.statusDisconnected };
    case "needs-auth":
      return {
        icon: cloudAlertIcon,
        label: s.statusNeedsAuth,
        tone: "warning",
      };
    case "syncing":
      return { icon: cloudUpIcon, label: s.statusSyncing };
    case "synced":
      return { icon: cloudCheckIcon, label: s.statusSynced };
    case "conflict":
      return { icon: cloudAlertIcon, label: s.statusConflict, tone: "warning" };
    case "error":
      return { icon: cloudAlertIcon, label: s.statusError, tone: "danger" };
  }
};

/** compact indicator for the top-right corner; hidden until connected */
export const DriveSyncStatusButton = () => {
  const s = strings;
  const status = useAtomValue(driveSyncStatusAtom);
  const [, setConflictDialogOpen] = useAtom(isConflictDialogOpenAtom);

  if (!DriveSync.isAvailable() || status.type === "disconnected") {
    return null;
  }

  const view = statusView(status, s);
  const title =
    status.type === "error"
      ? `${view.label}: ${status.message}`
      : status.type === "synced"
      ? `${view.label} · ${new Date(status.at).toLocaleTimeString()}`
      : view.label;

  return (
    <button
      type="button"
      className={clsx("DriveSyncStatus", view.tone && `is-${view.tone}`, {
        "is-syncing": status.type === "syncing",
      })}
      title={title}
      aria-label={title}
      onClick={() => {
        if (status.type === "needs-auth") {
          DriveSync.connect();
        } else if (status.type === "conflict") {
          setConflictDialogOpen(true);
        } else {
          DriveSync.syncNow();
        }
      }}
    >
      {view.icon}
      {status.type !== "synced" && status.type !== "syncing" && (
        <span className="DriveSyncStatus__label">{view.label}</span>
      )}
    </button>
  );
};

export const DriveSyncMenuItems = () => {
  const s = strings;
  const status = useAtomValue(driveSyncStatusAtom);

  if (!DriveSync.isAvailable()) {
    return null;
  }

  if (status.type === "disconnected") {
    return (
      <MainMenu.Item icon={cloudIcon} onSelect={() => DriveSync.connect()}>
        {s.menuConnect}
      </MainMenu.Item>
    );
  }

  return (
    <>
      {status.type === "needs-auth" ? (
        <MainMenu.Item
          icon={cloudAlertIcon}
          onSelect={() => DriveSync.connect()}
        >
          {s.menuReconnect}
        </MainMenu.Item>
      ) : (
        <MainMenu.Item icon={cloudUpIcon} onSelect={() => DriveSync.syncNow()}>
          {s.menuSyncNow}
        </MainMenu.Item>
      )}
      <MainMenu.Item
        icon={cloudOffIcon}
        onSelect={() => {
          if (window.confirm(s.disconnectConfirm)) {
            DriveSync.disconnect();
          }
        }}
      >
        {s.menuDisconnect}
      </MainMenu.Item>
    </>
  );
};

const ScenePreview = ({
  elements,
  viewBackgroundColor,
}: {
  elements: readonly NonDeletedExcalidrawElement[];
  viewBackgroundColor?: string;
}) => {
  const excalidrawAPI = useExcalidrawAPI();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container || !elements.length) {
      return;
    }
    let canceled = false;
    exportToSvg({
      elements,
      appState: {
        exportBackground: true,
        viewBackgroundColor: viewBackgroundColor || "#ffffff",
      },
      files: excalidrawAPI?.getFiles() || {},
      exportPadding: 10,
      skipInliningFonts: true,
    })
      .then((svg) => {
        if (!canceled) {
          svg.removeAttribute("width");
          svg.removeAttribute("height");
          container.replaceChildren(svg);
        }
      })
      .catch(console.error);
    return () => {
      canceled = true;
    };
  }, [elements, viewBackgroundColor, excalidrawAPI]);

  return <div className="DriveConflict__preview" ref={ref} />;
};

const SnapshotCard = ({
  title,
  summary,
  elements,
  viewBackgroundColor,
  s,
}: {
  title: string;
  summary: SnapshotSummary;
  elements: readonly NonDeletedExcalidrawElement[];
  viewBackgroundColor?: string;
  s: DriveStrings;
}) => (
  <div className="DriveConflict__card">
    <h4>{title}</h4>
    <ScenePreview
      elements={elements}
      viewBackgroundColor={viewBackgroundColor}
    />
    <dl>
      <dt>{s.lastEdited}</dt>
      <dd>
        {summary.updatedAt
          ? new Date(summary.updatedAt).toLocaleString()
          : s.never}
      </dd>
      <dt>{s.elements}</dt>
      <dd>{summary.elementCount}</dd>
      <dt>{s.libraryItems}</dt>
      <dd>{summary.libraryCount}</dd>
      {summary.device && (
        <>
          <dt>{s.device}</dt>
          <dd>{summary.device}</dd>
        </>
      )}
    </dl>
  </div>
);

export const DriveConflictDialog = () => {
  const s = strings;
  const excalidrawAPI = useExcalidrawAPI();
  const conflict = useAtomValue(driveConflictAtom);
  const [isOpen, setIsOpen] = useAtom(isConflictDialogOpenAtom);
  const [busy, setBusy] = useState(false);

  // reopen whenever a new conflict comes in
  useEffect(() => {
    if (conflict) {
      setIsOpen(true);
    }
  }, [conflict, setIsOpen]);

  if (!conflict || !isOpen) {
    return null;
  }

  const resolve = async (
    choice: "local" | "remote",
    opts: { backup?: boolean } = {},
  ) => {
    setBusy(true);
    try {
      if (opts.backup && excalidrawAPI) {
        const json = serializeAsJSON(
          excalidrawAPI.getSceneElements(),
          excalidrawAPI.getAppState(),
          excalidrawAPI.getFiles(),
          "local",
        );
        await fileSave(new Blob([json], { type: MIME_TYPES.excalidraw }), {
          name: `${excalidrawAPI.getName()} (backup)`,
          extension: "excalidraw",
          description: "Excalidraw file",
        });
      }
      await DriveSync.resolveConflict(choice);
    } catch (error: any) {
      // e.g. save dialog canceled -> keep the conflict dialog open
      if (error?.name !== "AbortError") {
        console.error(error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      size="regular"
      title={s.conflictTitle}
      onCloseRequest={() => setIsOpen(false)}
      className="DriveConflict"
    >
      <p className="DriveConflict__desc">{s.conflictDesc}</p>
      <div className="DriveConflict__cards">
        <SnapshotCard
          title={s.local}
          summary={conflict.local}
          elements={conflict.localElements}
          viewBackgroundColor={excalidrawAPI?.getAppState().viewBackgroundColor}
          s={s}
        />
        <SnapshotCard
          title={s.remote}
          summary={conflict.remote}
          elements={conflict.remoteElements}
          viewBackgroundColor={conflict.remoteViewBackgroundColor}
          s={s}
        />
      </div>
      <div className="DriveConflict__actions">
        <FilledButton
          size="large"
          variant="outlined"
          label={s.useLocal}
          onClick={() => resolve("local")}
          status={busy ? "loading" : null}
        />
        <FilledButton
          size="large"
          label={s.useRemote}
          onClick={() => resolve("remote")}
          status={busy ? "loading" : null}
        />
      </div>
      <div className="DriveConflict__backup">
        <button
          type="button"
          disabled={busy}
          onClick={() => resolve("remote", { backup: true })}
        >
          {s.backupThenRemote}
        </button>
      </div>
    </Dialog>
  );
};
