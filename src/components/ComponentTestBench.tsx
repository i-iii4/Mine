import type { ReactNode } from "react";
import { Plus, Trash2, Info, ExternalLink } from "lucide-react";
import { ActionButton } from "@/components/ActionButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function ComponentTestBench() {
  return (
    <div className="border-b border-border p-8">
      <p className="mb-6 font-mono text-sm text-muted-foreground">Component test bench</p>

      <Section label="Button — Sizes">
        <Button size="xs">xs 24px</Button>
        <Button>default 32px</Button>
      </Section>

      <Section label="Button — Variants">
        <Button variant="default">Default</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </Section>

      <Section label="Button — Icons">
        <Button size="xs"><Plus className="size-3" />Add</Button>
        <Button><Plus className="size-4" />Add</Button>
        <Button variant="destructive"><Trash2 className="size-4" />Delete</Button>
      </Section>

      <Section label="Button — Icon only">
        <Button size="icon-xs"><Plus className="size-3" /></Button>
        <Button size="icon"><Plus className="size-4" /></Button>
      </Section>

      <Section label="Button — Disabled">
        <Button disabled>Disabled</Button>
        <Button variant="destructive" disabled>Disabled</Button>
      </Section>

      <Section label="ActionButton (bottom bar)">
        <ActionButton hotkey="⌘K">Search</ActionButton>
        <ActionButton hotkey="⌘⇧N">New Channel</ActionButton>
        <ActionButton hotkey="⌘,">Settings</ActionButton>
        <ActionButton>No hotkey</ActionButton>
        <ActionButton hotkey="⌘⇧O" isSelected>Selected</ActionButton>
      </Section>

      <Section label="Input">
        <Input placeholder="Default" className="w-48" />
        <Input defaultValue="With value" className="w-48" />
        <Input disabled placeholder="Disabled" className="w-48" />
      </Section>

      <Section label="Input — Ghost">
        <Input variant="ghost" placeholder="Ghost input..." className="w-48" />
        <Input variant="ghost" defaultValue="With value" className="w-48" />
      </Section>

      <Section label="Checkbox">
        <div className="flex items-center gap-2">
          <Checkbox id="cb1" />
          <label htmlFor="cb1" className="text-base">Unchecked</label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="cb2" defaultChecked />
          <label htmlFor="cb2" className="text-base">Checked</label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="cb3" disabled />
          <label htmlFor="cb3" className="text-base text-muted-foreground">Disabled</label>
        </div>
      </Section>

      <Section label="Progress">
        <Progress value={0} className="w-64" />
        <Progress value={45} className="w-64" />
        <Progress value={100} className="w-64" />
      </Section>

      <Section label="Tooltip">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button><Info className="size-4" />Hover me</Button>
          </TooltipTrigger>
          <TooltipContent>Tooltip content</TooltipContent>
        </Tooltip>
      </Section>

      <Section label="DropdownMenu">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>Open menu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem><Plus className="size-3" />Action</DropdownMenuItem>
            <DropdownMenuItem><ExternalLink className="size-3" />Open link</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive"><Trash2 className="size-3" />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost">With submenu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Plus className="size-3" />Submenu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Sub item 1</DropdownMenuItem>
                <DropdownMenuItem>Sub item 2</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem>Regular item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      <Section label="ContextMenu (right-click the box)">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex h-16 w-48 items-center justify-center rounded-1 border border-dashed border-border text-sm text-muted-foreground">
              Right-click here
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Action</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive"><Trash2 className="size-3" />Delete</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Section>

      <Section label="AlertDialog">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Open dialog</Button>
          </AlertDialogTrigger>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive">Confirm</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Section>

      <Section label="Typography">
        <span className="text-sm text-foreground">text-sm (12px)</span>
        <span className="text-base text-foreground">text-base (14px)</span>
        <span className="text-lg text-foreground">text-lg (18px)</span>
      </Section>

      <Section label="Text hierarchy">
        <span className="text-base text-foreground">foreground</span>
        <span className="text-base text-muted-foreground">muted-foreground</span>
        <span className="text-base text-tertiary-foreground">tertiary-foreground</span>
      </Section>

      <Section label="Surfaces (background layering)" vertical>
        <div className="flex gap-2">
          <Swatch label="background" className="bg-background border border-border" />
          <Swatch label="accent (+1)" className="bg-accent" />
          <Swatch label="sidebar-accent (+2)" className="bg-sidebar-accent" />
          <Swatch label="active/border (+3)" className="bg-active" />
        </div>
      </Section>

      <Section label="Button tokens" vertical>
        <div className="flex gap-2">
          <Swatch label="component-fill" className="bg-component-fill" />
          <Swatch label="component-fill-inner" className="bg-component-fill-inner" />
          <Swatch label="component-fill-hover" className="bg-component-fill-hover" />
        </div>
      </Section>
    </div>
  );
}

function Section({ label, children, vertical }: { label: string; children: ReactNode; vertical?: boolean }) {
  return (
    <div className="mb-4">
      <p className="mb-2 font-mono text-sm text-muted-foreground">{label}</p>
      <div className={vertical ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"}>
        {children}
      </div>
    </div>
  );
}

function Swatch({ label, className }: { label: string; className: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`size-12 rounded-1 ${className}`} />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}
