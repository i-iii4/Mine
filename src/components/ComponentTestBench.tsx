import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ExternalLink,
  GripVertical,
  Info,
  MoreHorizontal,
  Plus,
  Strikethrough,
  X,
} from "lucide-react";
import { ActionButton } from "@/components/ActionButton";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import { CollectionPicker } from "@/components/CollectionPicker";
import { GroupSelectionActionBar } from "@/components/GroupSelectionActionBar";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { SearchMenuInput } from "@/components/SearchMenuInput";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { LightBlock, TagCount } from "@/types";
import { ChannelList } from "../../extension/popup/components/ChannelList";
import { SaveButton } from "../../extension/popup/components/SaveButton";
import { ScreenshotPreview } from "../../extension/popup/components/ScreenshotPreview";
import { StatusBar } from "../../extension/popup/components/StatusBar";
import { TypeSwitcher } from "../../extension/popup/components/TypeSwitcher";
import { VaultSelect } from "../../extension/popup/components/VaultSelect";
import type { ChannelInfo } from "../../extension/popup/lib/messaging";

type TokenGroup = {
  title: string;
  tokens: readonly string[];
};

type RedactionIconVariant = {
  family: string;
  label: string;
  glyph: "m";
  style: "regular" | "italic";
};

type ClipPreviewType = "content" | "screenshot" | "link" | "image";

const actualMineIconVariant: RedactionIconVariant = {
  family: "Redaction 100",
  label: "Redaction 100 Italic",
  glyph: "m",
  style: "italic",
};

const COLOR_TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    title: "Production surfaces",
    tokens: [
      "--background",
      "--chrome",
      "--card",
      "--popover",
      "--secondary",
      "--muted",
      "--accent",
      "--active",
      "--border",
      "--border-accent",
      "--input",
    ],
  },
  {
    title: "Production text",
    tokens: [
      "--foreground",
      "--muted-foreground",
      "--tertiary-foreground",
      "--hover-foreground",
      "--popover-foreground",
      "--accent-foreground",
    ],
  },
  {
    title: "Interactive components",
    tokens: [
      "--component-fill",
      "--component-fill-inner",
      "--component-fill-hover",
      "--destructive",
      "--primary",
      "--primary-foreground",
    ],
  },
  {
    title: "Shell and feed states",
    tokens: [
      "--sidebar",
      "--sidebar-border",
      "--glass-bg",
      "--card-hover-overlay",
      "--graphic-card-focus-overlay",
      "--feed-selection-frame",
    ],
  },
];

const RADIUS_TOKENS = [
  { token: "--radius-0", label: "0px / hard content edges" },
  { token: "--radius-1", label: "3px / buttons, menus, controls" },
  { token: "--radius-2", label: "5px / channel thumbnail stack" },
  { token: "--radius-round", label: "50% / circular clipper controls" },
  { token: "--radius-card", label: "feed card frame alias" },
  { token: "--radius-media", label: "feed media alias" },
] as const;

const SPACING_TOKENS = [
  { token: "--spacing-s3", label: "16px / selection action bar bottom offset" },
] as const;

const TYPE_TOKENS = [
  { className: "text-sm", label: "text-sm / 12px / 16px" },
  { className: "text-base", label: "text-base / 14px / 20px" },
  { className: "text-lg", label: "text-lg / 18px / 24px" },
] as const;

const SAMPLE_TAGS: TagCount[] = [
  { tag: "beautiful-web", count: 30 },
  { tag: "catalogs", count: 7 },
  { tag: "periphery", count: 8 },
  { tag: "typography", count: 6 },
  { tag: "very-long-channel-name", count: 6 },
  { tag: "local-first", count: 3 },
];

const CLIPPER_CHANNELS: ChannelInfo[] = SAMPLE_TAGS.map((tag) => ({
  tag: tag.tag,
  block_count: tag.count,
}));

const GROUP_SELECTION_BLOCKS: LightBlock[] = [
  sampleBlock("catalog-cover", "Catalog cover", "image"),
  sampleBlock("braun-tax", "Braun Design Tax", "article"),
  sampleBlock("memory-birds", "Memory is a flock of birds", "article"),
];

const SEGMENT_OPTIONS: readonly SegmentedControlOption<"all" | "connected">[] = [
  { value: "all", label: "All" },
  { value: "connected", label: "Connected" },
];

const SCREENSHOT_DATA_URL = svgDataUrl(`
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560">
    <rect width="960" height="560" fill="#f5f5f5"/>
    <rect x="64" y="54" width="832" height="64" fill="#111"/>
    <rect x="140" y="170" width="240" height="120" fill="#d8d8d8"/>
    <rect x="440" y="170" width="260" height="120" fill="#d8d8d8"/>
    <rect x="140" y="330" width="560" height="24" fill="#111"/>
    <rect x="140" y="374" width="430" height="18" fill="#777"/>
    <rect x="140" y="410" width="500" height="18" fill="#aaa"/>
  </svg>
`);

const ARTICLE_IMAGE_DATA_URL = svgDataUrl(`
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560">
    <rect width="960" height="560" fill="#111"/>
    <rect x="48" y="48" width="864" height="464" fill="#efefef"/>
    <circle cx="280" cy="260" r="128" fill="#222"/>
    <rect x="472" y="176" width="300" height="28" fill="#222"/>
    <rect x="472" y="232" width="360" height="18" fill="#777"/>
    <rect x="472" y="268" width="280" height="18" fill="#999"/>
    <rect x="472" y="336" width="220" height="44" fill="#111"/>
  </svg>
`);

export function ComponentTestBench() {
  return (
    <TooltipProvider>
      <div className="min-h-full bg-background text-foreground" data-design-system-bench="">
        <div className="border-b border-border px-8 py-6">
          <p className="font-mono text-sm text-muted-foreground">Design system audit surface</p>
          <h1 className="mt-2 text-lg font-semibold">Production tokens and components</h1>
          <p className="mt-2 max-w-3xl text-base text-muted-foreground">
            This page imports real app and Clipper primitives. If a production
            state is missing here, the page is stale. If a state appears here
            but has no production primitive, the implementation is drifting.
          </p>
        </div>

        <div className="grid gap-8 px-8 py-8">
          <AuditContractPanel />
          <TokenAuditSection />
          <CoreComponentSection />
          <FloatingUiSection />
          <ShellAndSelectionSection />
          <CardPatternSection />
          <ClipperParitySection />
          <AppIconTemplateBench />
        </div>
      </div>
    </TooltipProvider>
  );
}

function AuditContractPanel() {
  return (
    <BenchSection
      title="Coverage contract"
      description="The page is a visual checklist for prod UI, not a separate style guide."
    >
      <div className="grid gap-2 md:grid-cols-3">
        <ContractCard title="Tokens">
          Only CSS variables with live app or Clipper references are shown.
          Tokens that exist only as unused shadcn defaults stay out of this
          audit surface.
        </ContractCard>
        <ContractCard title="Components">
          Components are imported from production files. Hand-made lookalikes
          are allowed only for composition notes, never as the source of visual truth.
        </ContractCard>
        <ContractCard title="Clipper">
          Clipper is represented as full popup states and must reuse app
          primitives: space trigger, segmented control, channel picker,
          buttons, search input, and close action.
        </ContractCard>
      </div>
    </BenchSection>
  );
}

function TokenAuditSection() {
  return (
    <BenchSection
      title="Tokens"
      description="Production-used values are read from the current root theme. Switch the app theme to audit both light and dark."
    >
      <div className="grid gap-4 xl:grid-cols-2">
        {COLOR_TOKEN_GROUPS.map((group) => (
          <TokenPanel key={group.title} title={group.title}>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.tokens.map((token) => (
                <ColorTokenChip key={token} token={token} />
              ))}
            </div>
          </TokenPanel>
        ))}

        <TokenPanel title="Radius">
          <div className="grid gap-2 sm:grid-cols-2">
            {RADIUS_TOKENS.map((item) => (
              <DimensionTokenChip key={item.token} token={item.token} label={item.label} kind="radius" />
            ))}
          </div>
        </TokenPanel>

        <TokenPanel title="Spacing">
          <div className="grid gap-2 sm:grid-cols-2">
            {SPACING_TOKENS.map((item) => (
              <DimensionTokenChip key={item.token} token={item.token} label={item.label} kind="spacing" />
            ))}
          </div>
        </TokenPanel>

        <TokenPanel title="Typography">
          <div className="grid gap-2">
            {TYPE_TOKENS.map((item) => (
              <div key={item.label} className="rounded-1 border border-border p-3">
                <p className="font-mono text-sm text-muted-foreground">{item.label}</p>
                <p className={cn(item.className, "mt-2 text-foreground")}>
                  The quick brown fox checks Mine UI rhythm.
                </p>
              </div>
            ))}
          </div>
        </TokenPanel>
      </div>
    </BenchSection>
  );
}

function CoreComponentSection() {
  return (
    <BenchSection
      title="Core components"
      description="Base primitives and all product sizes/states."
    >
      <ComponentSpec label="Button default — h=32, radius=3, bg=component-fill">
        <Button size="xs">xs 24</Button>
        <Button size="sm">sm 28</Button>
        <Button>default 32</Button>
        <Button size="clipper">clipper 40</Button>
        <Button disabled>Disabled</Button>
      </ComponentSpec>

      <ComponentSpec label="Button variants — hover outline=component-fill-hover">
        <Button variant="default"><Plus />Connect</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button size="icon" aria-label="More"><MoreHorizontal /></Button>
        <ChromeCloseButton label="Close design preview" />
      </ComponentSpec>

      <ComponentSpec label="ActionButton — root h=24, inner h=20, radius=3/2">
        <ActionButton hotkey="⌘⇧N">New Channel</ActionButton>
        <ActionButton hotkey="⌘,">Settings</ActionButton>
        <ActionButton>No hotkey</ActionButton>
        <ActionButton hotkey="⌘K" isSelected>Selected</ActionButton>
      </ComponentSpec>

      <ComponentSpec label="SegmentedControl — compact h=24, default h=32, clipper h=32">
        <SegmentedControl
          value="all"
          options={SEGMENT_OPTIONS}
          onChange={() => {}}
          aria-label="Compact channel filter"
          size="compact"
        />
        <SegmentedControl
          value="connected"
          options={SEGMENT_OPTIONS}
          onChange={() => {}}
          aria-label="Default channel filter"
          size="default"
        />
        <SegmentedControl
          value="all"
          options={SEGMENT_OPTIONS}
          onChange={() => {}}
          aria-label="Clipper channel filter"
          size="clipper"
        />
      </ComponentSpec>

      <ComponentSpec label="Input — h=32 default, h=40 clipper, radius=3">
        <Input placeholder="Default input" className="w-56" />
        <Input defaultValue="Filled input" className="w-56" />
        <Input variant="ghost" placeholder="Ghost input..." className="w-56" />
        <Input controlSize="clipper" placeholder="Clipper input 40" className="w-56" />
        <Input disabled placeholder="Disabled" className="w-56" />
      </ComponentSpec>

      <ComponentSpec label="SearchMenuInput — flat menu header, border-b, no input pill">
        <div className="w-80 overflow-hidden rounded-1 border border-border bg-popover">
          <SearchMenuInput placeholder="Search channels..." />
          <SearchMenuAction active onPress={() => {}}>
            <span className="truncate">Beautiful web</span>
            <span className="ml-auto text-muted-foreground">30</span>
          </SearchMenuAction>
        </div>
        <div className="w-80 overflow-hidden rounded-1 border border-border bg-popover">
          <SearchMenuInput controlSize="clipper" placeholder="Search spaces..." />
          <SearchMenuAction rowSize="clipper" active onPress={() => {}}>
            <span className="truncate">Mine</span>
          </SearchMenuAction>
        </div>
      </ComponentSpec>

      <ComponentSpec label="MenuTextTrigger — topChrome, clipperHeader, actionBar">
        <div className="flex h-8 items-center gap-0 overflow-hidden rounded-1 border border-border bg-chrome">
          <MenuTextTrigger label="Mine" surface="topChrome" className="px-3" />
          <MenuTextTrigger label="Everything" surface="topChrome" className="px-6" />
        </div>
        <div className="flex h-10 w-80 items-center border border-border bg-accent px-2">
          <MenuTextTrigger label="Mine" surface="clipperHeader" showChevron />
        </div>
        <MenuTextTrigger label="Action" surface="actionBar" hotkey="⌘A" />
      </ComponentSpec>

      <ComponentSpec label="Checkbox / Progress / Tooltip — shared primitives">
        <label className="inline-flex items-center gap-2 text-base">
          <Checkbox />
          Unchecked
        </label>
        <label className="inline-flex items-center gap-2 text-base">
          <Checkbox defaultChecked />
          Checked
        </label>
        <Progress value={45} className="w-56" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button><Info />Tooltip</Button>
          </TooltipTrigger>
          <TooltipContent>Design-system tooltip</TooltipContent>
        </Tooltip>
      </ComponentSpec>
    </BenchSection>
  );
}

function FloatingUiSection() {
  return (
    <BenchSection
      title="Floating UI"
      description="Menus expose width roles and quantized row-height contracts."
    >
      <ComponentSpec label="DropdownMenu command — width=max-content, min=12rem, max=18.75rem">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>Open command menu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent widthRole="command">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Plus className="size-3" />
                Connect
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent widthRole="picker" className="p-0">
                <CollectionPicker
                  blockSlug="bench-card"
                  selectedTags={["beautiful-web"]}
                  tags={SAMPLE_TAGS}
                  onToggleTag={() => {}}
                  onCreateAndAssign={() => {}}
                  stopKeyPropagation
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem>
              <ExternalLink className="size-3" />
              Source
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Reveal in Finder</DropdownMenuItem>
            <DropdownMenuItem>Copy Path</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ComponentSpec>

      <ComponentSpec label="ContextMenu command — right click surface">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex h-16 w-64 items-center justify-center rounded-1 border border-dashed border-border text-sm text-muted-foreground">
              Right-click target
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Create Card</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </ComponentSpec>

      <ComponentSpec label="QuantizedMenuScrollArea — default row=32, clipper row=40">
        <div className="w-72 rounded-1 border border-border bg-popover">
          <QuantizedMenuScrollArea rowCount={6} maxRows={4} innerClassName="p-1">
            {SAMPLE_TAGS.map((tag) => (
              <SearchMenuAction key={tag.tag} onPress={() => {}}>
                <span className="truncate">{tag.tag}</span>
                <span className="ml-auto text-muted-foreground">{tag.count}</span>
              </SearchMenuAction>
            ))}
          </QuantizedMenuScrollArea>
        </div>
        <div className="w-72 rounded-1 border border-border bg-popover">
          <QuantizedMenuScrollArea rowCount={6} rowSize="clipper" maxRows={4} innerClassName="p-1">
            {SAMPLE_TAGS.map((tag) => (
              <SearchMenuAction key={tag.tag} rowSize="clipper" onPress={() => {}}>
                <span className="truncate">{tag.tag}</span>
                <span className="ml-auto text-muted-foreground">{tag.count}</span>
              </SearchMenuAction>
            ))}
          </QuantizedMenuScrollArea>
        </div>
      </ComponentSpec>
    </BenchSection>
  );
}

function ShellAndSelectionSection() {
  return (
    <BenchSection
      title="Shell and batch selection"
      description="Top chrome, secondary chrome, bottom/action islands, and selection actions."
    >
      <ComponentSpec label="Top chrome — h=32, bg=chrome, font=mono 12/16">
        <div className="grid w-full overflow-hidden rounded-1 border border-border">
          <div className="grid h-8 grid-cols-[160px_1fr] bg-chrome font-mono text-sm text-muted-foreground">
            <div className="flex items-center border-r border-border px-3">Mine</div>
            <div className="flex items-center justify-between px-3">
              <span>Everything</span>
              <span>⌘, Settings</span>
            </div>
          </div>
          <div className="grid h-8 grid-cols-[160px_1fr] border-t border-border bg-background font-mono text-sm text-tertiary-foreground">
            <div className="flex items-center border-r border-border px-3">128 files · 42 .md · 86 media</div>
            <div className="flex items-center px-3">128 cards</div>
          </div>
        </div>
      </ComponentSpec>

      <ComponentSpec label="GroupSelectionActionBar — h=32, bg=accent, bottom offset=16">
        <div className="relative h-32 w-full overflow-hidden rounded-1 border border-border bg-background">
          <GroupSelectionActionBar
            selectedBlocks={GROUP_SELECTION_BLOCKS}
            tags={SAMPLE_TAGS}
            currentTag="beautiful-web"
            onLoadBlockTags={async () => new Map([
              ["catalog-cover", ["beautiful-web"]],
              ["braun-tax", ["catalogs"]],
              ["memory-birds", []],
            ])}
            onBatchSetTag={() => {}}
            onCreateAndAssignBatch={() => {}}
            onDeleteSelectedBlocks={async () => {}}
            onMergeSelectedBlocks={() => {}}
            onClearSelection={() => {}}
          />
        </div>
      </ComponentSpec>
    </BenchSection>
  );
}

function CardPatternSection() {
  return (
    <BenchSection
      title="Cards and inline action patterns"
      description="Card states that are not isolated shadcn primitives."
    >
      <ComponentSpec label="Feed graphic focus — frame=2px outside, wash=graphic-card-focus-overlay">
        <div className="grid max-w-5xl gap-4 md:grid-cols-3">
          <FeedCardPreview state="default" />
          <FeedCardPreview state="keyboard" />
          <FeedCardPreview state="selected" />
        </div>
      </ComponentSpec>

      <ComponentSpec label="Focused card badge — h=24, left/top=8, text=⌘K">
        <div className="relative w-80 border border-border bg-card p-3">
          <img src={ARTICLE_IMAGE_DATA_URL} alt="" className="block w-full rounded-0" />
          <div className="pointer-events-none absolute left-5 top-5 rounded-1 bg-component-fill px-[1ch] font-mono text-sm font-semibold text-foreground">
            ⌘K
          </div>
          <p className="mt-3 text-base text-muted-foreground">
            Graphic card keeps media as the visual focus while badge explains the scoped shortcut.
          </p>
        </div>
      </ComponentSpec>

      <ComponentSpec label="Text selection action island — compact, shared button contract">
        <div className="inline-flex h-8 items-center gap-1 rounded-1 border border-border bg-accent px-1 shadow-md">
          <Button size="xs"><Plus className="size-3" />Create Card</Button>
          <Button size="xs" variant="destructive"><Strikethrough className="size-3" />Delete Text</Button>
          <Button size="icon-xs" variant="ghost" aria-label="Close text selection menu">
            <X className="size-3" />
          </Button>
        </div>
      </ComponentSpec>

      <ComponentSpec label="Drag stack — macOS-style offset preview, no layout mutation">
        <div className="relative h-28 w-72">
          {[2, 1, 0].map((index) => (
            <div
              key={index}
              className="absolute h-20 w-56 rounded-1 border border-border bg-card shadow-md"
              style={{
                left: index * 9,
                top: index * 7,
                transform: `rotate(${index === 0 ? -1 : index === 1 ? 0.7 : 1.6}deg)`,
              }}
            >
              <div className="flex h-full items-center gap-3 p-3">
                <GripVertical className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-base font-semibold">3 selected cards</p>
                  <p className="text-sm text-muted-foreground">Drag stack preview</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </ComponentSpec>
    </BenchSection>
  );
}

function ClipperParitySection() {
  return (
    <BenchSection
      title="Web Clipper"
      description="Full popup states at the actual 360px width. Components below are imported from extension/popup."
    >
      <div className="grid gap-6 xl:grid-cols-2">
        <ClipperFrame type="content" />
        <ClipperFrame type="screenshot" />
        <ClipperFrame type="link" />
        <ClipperFrame type="image" />
      </div>
    </BenchSection>
  );
}

function ClipperFrame({ type }: { type: ClipPreviewType }) {
  const hasTypeRow = type !== "image";
  const title = type === "image" ? "Clipper image — no Type row" : `Clipper ${type} — width=360`;

  return (
    <div>
      <p className="mb-2 font-mono text-sm text-muted-foreground">{title}</p>
      <div className="w-[360px] overflow-hidden rounded-1 border border-border bg-background shadow-md">
        <VaultSelect
          value="/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine"
          options={[
            "/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine",
            "/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Journal",
          ]}
          onChange={() => {}}
          onClose={() => {}}
        />

        {hasTypeRow && (
          <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-chrome px-4">
            <span className="text-base text-muted-foreground">Type:</span>
            <TypeSwitcher current={type} onChange={() => {}} />
          </div>
        )}

        <div className="mine-clipper-body" data-after-type={hasTypeRow ? "true" : "false"}>
          <div className="mine-clipper-section-stack">
            {type === "content" && <ClipperContentPreview />}
            {type === "screenshot" && (
              <ScreenshotPreview
                dataUrl={SCREENSHOT_DATA_URL}
                cropSupported
                onCrop={() => {}}
                onRetake={() => {}}
              />
            )}
            {type === "link" && <ClipperLinkPreview />}
            {type === "image" && <ClipperImagePreview />}
          </div>

          <ChannelList
            channels={CLIPPER_CHANNELS}
            selectedTags={["beautiful-web"]}
            recentTags={["beautiful-web", "catalogs"]}
            onToggle={() => {}}
            onCreate={() => {}}
          />

          <div className="mine-clipper-section-stack">
            <SaveButton count={1} saving={false} onClick={() => {}} />
            {type === "content" && (
              <StatusBar message="Saved state / error state uses same slot" type="success" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClipperContentPreview() {
  return (
    <div className="max-h-[280px] overflow-y-auto rounded-1 border border-border p-2">
      <div className="mine-clipper-article-preview prose prose-sm mt-1.5 max-w-none">
        <h1>Design systems are contracts</h1>
        <p>
          A component page is useful only when it reuses production primitives
          and makes drift visible before it reaches the interface.
        </p>
        <img src={ARTICLE_IMAGE_DATA_URL} alt="" loading="lazy" />
      </div>
    </div>
  );
}

function ClipperLinkPreview() {
  return (
    <div className="space-y-1.5 rounded-1 border border-border p-2">
      <div className="rounded-1 bg-accent">
        <img
          src={ARTICLE_IMAGE_DATA_URL}
          alt=""
          className="mx-auto block max-h-[120px] w-auto max-w-full rounded-1 object-contain"
        />
      </div>
      <p className="truncate text-sm font-semibold">A quiet interface contract</p>
      <p className="line-clamp-2 text-sm text-muted-foreground">
        Link previews keep the same type scale and surface hierarchy as cards.
      </p>
      <p className="truncate text-sm text-tertiary-foreground">example.com</p>
    </div>
  );
}

function ClipperImagePreview() {
  return (
    <div className="rounded-1 border border-border bg-accent">
      <img
        src={ARTICLE_IMAGE_DATA_URL}
        alt=""
        className="mx-auto block max-h-[220px] w-auto max-w-full rounded-1 object-contain"
      />
    </div>
  );
}

function FeedCardPreview({ state }: { state: "default" | "keyboard" | "selected" }) {
  const label = state === "default"
    ? "default"
    : state === "keyboard"
      ? "keyboard focus"
      : "batch selected";

  return (
    <div className="relative">
      {state === "selected" && (
        <div className="absolute -inset-[3px] border-2 border-[var(--feed-selection-frame)]" />
      )}
      <div className="relative border border-border bg-card">
        <div className="relative overflow-hidden bg-accent">
          <img src={ARTICLE_IMAGE_DATA_URL} alt="" className="block aspect-[4/3] w-full object-cover" />
          {state === "keyboard" && (
            <div className="absolute inset-0 bg-[var(--graphic-card-focus-overlay)]" />
          )}
        </div>
        <div className="p-3">
          <p className="text-base font-semibold text-foreground">{label}</p>
          <p className="mt-1 text-base text-muted-foreground">
            Graphic card surface, card radius 0, hover controls are separate.
          </p>
        </div>
      </div>
    </div>
  );
}

function TokenPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-1 border border-border p-4">
      <p className="mb-3 font-mono text-sm text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function ColorTokenChip({ token }: { token: string }) {
  return (
    <div className="grid grid-cols-[48px_1fr] gap-3 rounded-1 border border-border p-2">
      <div
        className="size-12 rounded-1 border border-border"
        style={{ background: `var(${token})` }}
      />
      <div className="min-w-0">
        <p className="truncate font-mono text-sm text-foreground">{token}</p>
        <CssVariableValue token={token} />
      </div>
    </div>
  );
}

function DimensionTokenChip({
  token,
  label,
  kind,
}: {
  token: string;
  label: string;
  kind: "spacing" | "radius";
}) {
  return (
    <div className="grid grid-cols-[64px_1fr] gap-3 rounded-1 border border-border p-2">
      <div className="flex h-12 items-center justify-center">
        {kind === "spacing" ? (
          <div className="h-4 bg-foreground" style={{ width: `var(${token})` }} />
        ) : (
          <div className="size-10 border border-foreground" style={{ borderRadius: `var(${token})` }} />
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate font-mono text-sm text-foreground">{token}</p>
        <p className="text-sm text-muted-foreground">{label}</p>
        <CssVariableValue token={token} />
      </div>
    </div>
  );
}

function CssVariableValue({ token }: { token: string }) {
  const value = useCssVariableValue(token);
  return (
    <p className="truncate font-mono text-sm text-tertiary-foreground">
      {value || `var(${token})`}
    </p>
  );
}

function useCssVariableValue(token: string): string {
  const [value, setValue] = useState("");

  useEffect(() => {
    const readValue = () => {
      setValue(window.getComputedStyle(document.documentElement).getPropertyValue(token).trim());
    };
    readValue();

    const observer = new MutationObserver(readValue);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [token]);

  return value;
}

function ComponentSpec({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-1 border border-border p-4">
      <p className="mb-3 font-mono text-sm text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  );
}

function BenchSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 max-w-3xl text-base text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="grid gap-4">
        {children}
      </div>
    </section>
  );
}

function ContractCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-1 border border-border bg-card p-4">
      <p className="font-mono text-sm text-foreground">{title}</p>
      <p className="mt-2 text-base text-muted-foreground">{children}</p>
    </div>
  );
}

function AppIconTemplateBench() {
  return (
    <BenchSection
      title="App icon"
      description="Icon source and masked previews stay here because the app icon is a design-system asset."
    >
      <div className="grid max-w-xl gap-4 [grid-template-columns:repeat(auto-fill,minmax(304px,1fr))]">
        <RedactionIconCard variant={actualMineIconVariant} />
      </div>
    </BenchSection>
  );
}

function RedactionIconCard({ variant }: { variant: RedactionIconVariant }) {
  return (
    <div className="rounded-1 border border-border bg-background p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm text-foreground">{variant.label}</p>
          <p className="font-mono text-sm text-muted-foreground">lowercase m</p>
        </div>
        <div
          className="text-lg leading-6 text-foreground"
          style={redactionGlyphStyle(variant, 24)}
        >
          {variant.glyph}
        </div>
      </div>

      <div className="flex items-end gap-3">
        <AppIconSourceTemplate variant={variant} />
        <div className="flex items-end gap-2">
          <AppIconMaskedPreview variant={variant} size={96} label="large" />
          <AppIconMaskedPreview variant={variant} size={56} label="small" />
          <AppIconMaskedPreview variant={variant} size={32} label="tiny" />
        </div>
      </div>
    </div>
  );
}

function AppIconSourceTemplate({ variant }: { variant: RedactionIconVariant }) {
  const size = 112;
  const grid = Math.max(1, Math.round(size / 8));

  return (
    <div className="flex flex-col gap-2">
      <div
        className="relative border border-border bg-white"
        style={{
          width: size,
          height: size,
        }}
      >
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #000 1px, transparent 1px), linear-gradient(to bottom, #000 1px, transparent 1px)",
            backgroundSize: `${grid}px ${grid}px`,
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <RedactionGlyph variant={variant} size={size * 0.72} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-sm text-muted-foreground">
        <span>source</span>
        <span>1024</span>
      </div>
    </div>
  );
}

function AppIconMaskedPreview({
  variant,
  size,
  label,
}: {
  variant: RedactionIconVariant;
  size: number;
  label: string;
}) {
  const grid = Math.max(1, Math.round(size / 8));

  return (
    <div className="flex flex-col gap-2">
      <div
        className="relative overflow-hidden border border-border bg-white shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
        style={{
          width: size,
          height: size,
          borderRadius: `${size * 0.2237}px`,
        }}
      >
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #000 1px, transparent 1px), linear-gradient(to bottom, #000 1px, transparent 1px)",
            backgroundSize: `${grid}px ${grid}px`,
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <RedactionGlyph variant={variant} size={size * 0.72} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-sm text-muted-foreground">
        <span>{label}</span>
      </div>
    </div>
  );
}

function RedactionGlyph({ variant, size }: { variant: RedactionIconVariant; size: number }) {
  return (
    <div
      className="select-none text-black"
      style={redactionGlyphStyle(variant, size)}
    >
      {variant.glyph}
    </div>
  );
}

function redactionGlyphStyle(variant: RedactionIconVariant, size: number): CSSProperties {
  return {
    fontFamily: `"${variant.family}", "Redaction", serif`,
    fontSize: size,
    fontStyle: variant.style === "italic" ? "italic" : "normal",
    fontWeight: 400,
    lineHeight: 1,
    letterSpacing: 0,
  };
}

function sampleBlock(slug: string, title: string, blockType: LightBlock["block_type"]): LightBlock {
  return {
    id: slug.length,
    slug,
    card_kind: blockType === "image" ? "media" : "article",
    block_type: blockType,
    title,
    content_heading: title,
    display_title: title,
    fallback_label: title,
    url: "https://example.com",
    media_file: blockType === "image" ? "image.jpg" : null,
    thumbnail: null,
    saved_at: "2026-05-31T00:00:00Z",
    width: 960,
    height: 560,
    author: "Mine",
    body: "Sample block for design-system bench.",
    preview_text: "Sample block for design-system bench.",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    search_match: null,
  };
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
