// The ellipsis menu in the clipper header (О3).
//
// Availability comes from a handshake, never from a guess about installation.

import { useState } from "react";
import { AppWindow, Download, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import { sendToNative } from "../lib/messaging";
import { openDownloadPage } from "../lib/standalone";

interface ClipperOverflowMenuProps {
  canOpenApp: boolean;
  onRetryConnection?: () => Promise<unknown>;
  onChooseNativeFolder?: () => Promise<unknown>;
}

export function ClipperOverflowMenu({ canOpenApp, onRetryConnection, onChooseNativeFolder }: ClipperOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="More"
          data-clipper-overflow-trigger=""
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
        {canOpenApp ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void sendToNative({ action: "open_app" }).then((result) => {
                setError(result.ok ? null : result.error ?? "Could not open Mine");
                if (result.ok) setOpen(false);
              });
            }}
          >
            <MenuIconSlot>
              <AppWindow className="size-3" />
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
              <Download className="size-3" />
            </MenuIconSlot>
            Download app
          </DropdownMenuItem>
        )}
        {error && <p className="px-2 py-1 text-sm text-destructive" role="alert">{error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
