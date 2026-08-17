// The ellipsis menu in the clipper header (О3).
//
// Always the same two ideas in one place: reach the app when it is installed,
// reach its download page when it is not. The pair never shows together —
// which one appears is the mode itself, so the menu doubles as the honest
// answer to "is the app here?" without a status line.

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
import { APP_DOWNLOAD_URL } from "./StandaloneSetup";

interface ClipperOverflowMenuProps {
  appInstalled: boolean;
}

export function ClipperOverflowMenu({ appInstalled }: ClipperOverflowMenuProps) {
  const [open, setOpen] = useState(false);

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
        {appInstalled ? (
          <DropdownMenuItem
            onSelect={() => {
              void sendToNative({ action: "open_app" });
            }}
          >
            <MenuIconSlot>
              <AppWindow className="size-3" />
            </MenuIconSlot>
            Open app
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              void chrome.tabs?.create({ url: APP_DOWNLOAD_URL });
            }}
          >
            <MenuIconSlot>
              <Download className="size-3" />
            </MenuIconSlot>
            Download app
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
