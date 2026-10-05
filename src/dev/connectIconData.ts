import {
  Album,
  ArrowDownToLine,
  Bookmark,
  BookmarkCheck,
  BookmarkMinus,
  BookmarkPlus,
  BookmarkX,
  Cable,
  CircleCheck,
  CircleMinus,
  CirclePlus,
  FolderCheck,
  FolderInput,
  FolderMinus,
  FolderOutput,
  FolderPlus,
  FolderX,
  Grid2x2Check,
  Grid2x2Plus,
  Grid2x2X,
  Hash,
  Inbox,
  Layers,
  Layers2,
  Library,
  LibraryBig,
  Link,
  Link2,
  Link2Off,
  ListCheck,
  ListMinus,
  ListPlus,
  ListX,
  Network,
  Paperclip,
  Pin,
  PinOff,
  Plug,
  PlugZap,
  Spline,
  SquareCheck,
  SquareLibrary,
  SquareMinus,
  SquarePlus,
  SquareStack,
  Tag,
  Tags,
  Unlink,
  Unlink2,
  Unplug,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

// Icon candidates for the Connect buttons (`/__connect-icons` on the dev
// server), read from the code on 04.10.2026. All from lucide, the one icon set
// Mine uses; nothing here is used by the app.

export interface NamedIcon {
  name: string;
  Icon: LucideIcon;
}

export interface Metaphor {
  title: string;
  /** What the icon tells the person, in one sentence. */
  meaning: string;
  /** Candidates for the Connect action itself. */
  connect: readonly NamedIcon[];
  /** The matching icon for a card already in the collection, where lucide has one. */
  connected?: readonly NamedIcon[];
  /** The matching icon for Disconnect, where lucide has one. */
  disconnect?: readonly NamedIcon[];
  /** A clash with a meaning the icon already has in Mine or in common use. */
  caveat?: string;
}

export interface Place {
  what: string;
  where: string;
}

const icon = (name: string, Icon: LucideIcon): NamedIcon => ({ name, Icon });

export const CURRENT_CONNECT: NamedIcon = icon("ListPlus", ListPlus);

/** Where Connect is today and what it draws. */
export const CONNECT_PLACES: readonly Place[] = [
  { what: "Карточка в ленте: кнопка ListPlus при наведении (raised, 24 px, значок 13 px)", where: "CardHoverMenu.tsx:629" },
  { what: "Меню ⋯ карточки: пункт Connect с ListPlus и подменю коллекций", where: "CardHoverMenu.tsx:280" },
  { what: "Контекстное меню карточки: Connect с ListPlus; Disconnect уже с Unlink", where: "CardContextMenu.tsx:71, 119" },
  { what: "Открытая карточка: кнопка «Connect» с ListPlus после слова (default, 32 px)", where: "Detail.tsx:974" },
  { what: "Групповое выделение: кнопка «Connect» с ListPlus перед словом и пункты меню Connect", where: "GroupSelectionCommands.tsx:161, GroupSelectionCardMenu.tsx:127, GroupSelectionContextMenu.tsx:79" },
  { what: "Строка коллекции в боковом меню: плашка Connect / Connected / Disconnect, только слово", where: "Sidebar.tsx:1537" },
  { what: "Клиппер: значка Connect нет, коллекции выбираются в списке", where: "extension/popup" },
];

/** Where the plus already means something else: the clash to avoid. */
export const PLUS_ELSEWHERE: readonly Place[] = [
  { what: "New Collection над таблицей коллекций и во втором ряду", where: "App.tsx:4454, MainSecondaryChrome.tsx:88" },
  { what: "New Tab в полосе вкладок и Open in New Tab в выборе пространства", where: "TabBar.tsx:704, VaultSwitcher.tsx:665" },
  { what: "Create New Collection в боковом меню (16 px)", where: "Sidebar.tsx:1996" },
  { what: "Create «…» в выборе коллекций и Create Element", where: "CollectionPicker.tsx:475, 773, Detail.tsx:2004, 3354" },
  { what: "Zoom in в просмотре картинки", where: "ImagePreviewOverlay.tsx:558" },
  { what: "FolderPlus уже значит новое пространство (выбор пространства, клиппер)", where: "VaultSwitcher.tsx:520, 540, extension VaultSelect.tsx:258" },
];

export const METAPHORS: readonly Metaphor[] = [
  {
    title: "Связь",
    meaning: "Карточка связывается с коллекцией, и связь можно разорвать; Disconnect в меню уже рисует Unlink, так что пара готова.",
    connect: [icon("Link", Link), icon("Link2", Link2)],
    disconnect: [icon("Unlink", Unlink), icon("Unlink2", Unlink2), icon("Link2Off", Link2Off)],
  },
  {
    title: "Подключение",
    meaning: "Карточку подключают к коллекции, как вилку к розетке; Plug и Unplug прямо называют Connect и Disconnect.",
    connect: [icon("Plug", Plug), icon("Cable", Cable)],
    connected: [icon("PlugZap", PlugZap)],
    disconnect: [icon("Unplug", Unplug)],
  },
  {
    title: "Закладка",
    meaning: "Карточку сохраняют в коллекцию, как в закладки; у закладки есть все три состояния.",
    connect: [icon("BookmarkPlus", BookmarkPlus), icon("Bookmark", Bookmark)],
    connected: [icon("BookmarkCheck", BookmarkCheck)],
    disconnect: [icon("BookmarkMinus", BookmarkMinus), icon("BookmarkX", BookmarkX)],
  },
  {
    title: "Папка",
    meaning: "Карточку кладут в коллекцию, как файл в папку.",
    connect: [icon("FolderPlus", FolderPlus), icon("FolderInput", FolderInput)],
    connected: [icon("FolderCheck", FolderCheck)],
    disconnect: [icon("FolderMinus", FolderMinus), icon("FolderX", FolderX), icon("FolderOutput", FolderOutput)],
    caveat: "FolderPlus в Mine уже значит новое пространство.",
  },
  {
    title: "Список",
    meaning: "Карточку добавляют в список, а коллекция в боковом меню и есть список.",
    connect: [icon("ListPlus", ListPlus)],
    connected: [icon("ListCheck", ListCheck)],
    disconnect: [icon("ListMinus", ListMinus), icon("ListX", ListX)],
  },
  {
    title: "Собрание",
    meaning: "Карточку ставят на полку собрания; состояний у этих значков нет.",
    connect: [icon("Library", Library), icon("LibraryBig", LibraryBig), icon("SquareLibrary", SquareLibrary), icon("Album", Album)],
  },
  {
    title: "Стопка",
    meaning: "Карточку кладут в стопку к остальным карточкам коллекции; состояний нет.",
    connect: [icon("Layers", Layers), icon("Layers2", Layers2), icon("SquareStack", SquareStack)],
  },
  {
    title: "Метка",
    meaning: "Карточку помечают именем коллекции; состояний нет.",
    connect: [icon("Tag", Tag), icon("Tags", Tags), icon("Hash", Hash)],
    caveat: "В Mine у карточки есть и обычные теги Obsidian (поле tags): метка может читаться как они.",
  },
  {
    title: "Крепление",
    meaning: "Карточку прикрепляют к коллекции булавкой или скрепкой.",
    connect: [icon("Pin", Pin), icon("Paperclip", Paperclip)],
    disconnect: [icon("PinOff", PinOff)],
    caveat: "Булавка обычно значит «закрепить наверху», скрепка значит вложение.",
  },
  {
    title: "Граф",
    meaning: "Карточка становится узлом в связях коллекции, как в виде Graph; состояний нет.",
    connect: [icon("Waypoints", Waypoints), icon("Network", Network), icon("Spline", Spline)],
  },
  {
    title: "Плюс в рамке",
    meaning: "Тот же смысл «добавить», но в рамке, чтобы отличаться от голого плюса, которым в Mine создают новое.",
    connect: [icon("CirclePlus", CirclePlus), icon("SquarePlus", SquarePlus), icon("Grid2x2Plus", Grid2x2Plus)],
    connected: [icon("CircleCheck", CircleCheck), icon("SquareCheck", SquareCheck), icon("Grid2x2Check", Grid2x2Check)],
    disconnect: [icon("CircleMinus", CircleMinus), icon("SquareMinus", SquareMinus), icon("Grid2x2X", Grid2x2X)],
  },
  {
    title: "Внутрь",
    meaning: "Карточку кладут внутрь коллекции, как во входящие; состояний нет.",
    connect: [icon("Inbox", Inbox), icon("ArrowDownToLine", ArrowDownToLine)],
  },
];
