import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ClipperOverflowMenu } from "./ClipperOverflowMenu";
const send = vi.hoisted(() => vi.fn().mockResolvedValue({ok:true}));
vi.mock("../lib/messaging", () => ({sendToNative: send}));
it("passes the selected space, not the desktop's previous binding", async () => {
  render(<ClipperOverflowMenu canOpenApp vaultPath="/tmp/Моё пространство" />);
  fireEvent.pointerDown(screen.getByRole("button", {name:"More"}), {button:0, pointerId:1});
  fireEvent.click(await screen.findByRole("menuitem", {name:"Open app"}));
  await waitFor(() => expect(send).toHaveBeenCalledWith({action:"open_app",path:"/tmp/Моё пространство"}));
});
