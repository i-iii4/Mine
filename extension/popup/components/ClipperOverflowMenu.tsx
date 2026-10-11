// The ellipsis menu in the clipper header (О3).
//
// Availability comes from a handshake, never from a guess about installation.
// The two switches of the Mine buttons on X and Instagram posts live here too
// (SPEC_CLIPPER.md, «Доработки после живого просмотра», пункт 5 и Р11).

import { useEffect, useState } from "react";
import { AppWindow, Download, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import "../../lib/feedButtonSettings.js";
import type { FeedButtonSettings } from "../../lib/feedButtonSettings";
import { sendToNative } from "../lib/messaging";
import { openDownloadPage } from "../lib/standalone";

const FEED_BUTTON_SWITCHES: ReadonlyArray<{ key: keyof FeedButtonSettings; label: string }> = [
  { key: "x", label: "Button on X posts" },
  { key: "instagram", label: "Button on Instagram posts" },
];

/// The extension's storage, where the clipper runs as part of the extension.
function extensionStorage(): typeof chrome.storage | null {
  const storage = globalThis.chrome?.storage;
  return storage?.local && storage.onChanged ? storage : null;
}

/// The switches of the Mine buttons as stored, followed while the menu lives:
/// another tab may change them meanwhile.
function useFeedButtonSettings(): [FeedButtonSettings, (key: keyof FeedButtonSettings, on: boolean) => Promise<void>] {
  const settings = globalThis.MineFeedButtonSettings;
  const [value, setValue] = useState<FeedButtonSettings>({ ...settings.DEFAULTS });
  useEffect(() => {
    const storage = extensionStorage();
    if (!storage) return;
    let live = true;
    void settings.read(storage.local).then((stored) => { if (live) setValue(stored); });
    const stop = settings.watch(storage, (stored) => setValue(stored));
    return () => {
      live = false;
      stop();
    };
  }, [settings]);
  const change = async (key: keyof FeedButtonSettings, on: boolean) => {
    const storage = extensionStorage();
    if (!storage) throw new Error("This switch works in the Mine extension only.");
    const next = { ...(await settings.read(storage.local)), [key]: on };
    await storage.local.set({ [settings.STORAGE_KEY]: next });
    setValue(next);
  };
  return [value, change];
}

interface ClipperOverflowMenuProps {
  canOpenApp: boolean;
  vaultPath?: string | null;
  onRetryConnection?: () => Promise<unknown>;
  onChooseNativeFolder?: () => Promise<unknown>;
}

export function ClipperOverflowMenu({ canOpenApp, vaultPath, onRetryConnection, onChooseNativeFolder }: ClipperOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedButtons, setFeedButton] = useFeedButtonSettings();

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="More"
          data-clipper-overflow-trigger=""
        >
          <MoreHorizontal className="size-[13px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        {canOpenApp ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void sendToNative({ action: "open_app", ...(vaultPath ? { path: vaultPath } : {}) }).then((result) => {
                setError(result.ok ? null : result.error ?? "Could not open Mine");
                if (result.ok) setOpen(false);
              });
            }}
          >
            <MenuIconSlot>
              <AppWindow className="size-[13px]" />
            </MenuIconSlot>
            Open app
          </DropdownMenuItem>
        ) : onRetryConnection ? (
          <DropdownMenuItem onSelect={() => { void onRetryConnection(); }}>Retry connection</DropdownMenuItem>
        ) : null}
        {canOpenApp && onChooseNativeFolder && (
          <DropdownMenuItem onSelect={(event) => {
            event.preventDefault();
            void onChooseNativeFolder().then(() => setOpen(false), (cause) => setError(cause instanceof Error ? cause.message : String(cause)));
          }}>Choose folder with Mine…</DropdownMenuItem>
        )}
        {!canOpenApp && (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void openDownloadPage().then((result) => {
                setError(result.ok ? null : result.error ?? "Could not open download page");
                if (result.ok) setOpen(false);
              });
            }}
          >
            <MenuIconSlot>
              <Download className="size-[13px]" />
            </MenuIconSlot>
            Download app
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {FEED_BUTTON_SWITCHES.map(({ key, label }) => (
          <DropdownMenuCheckboxItem
            key={key}
            checked={feedButtons[key]}
            // A switch keeps the menu open: the other one is a click away.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => {
              void setFeedButton(key, checked === true).then(
                () => setError(null),
                (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
              );
            }}
          >
            {label}
          </DropdownMenuCheckboxItem>
        ))}
        {error && <p className="px-2 py-1 text-sm text-destructive" role="alert">{error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
