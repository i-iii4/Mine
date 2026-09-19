import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const entry = "/sidebar-action-audit-entry.js";
const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, hmr: false, open: false },
  plugins: [{
    name: "sidebar-action-audit",
    resolveId(id) { if (id === entry) return `\0${entry}`; },
    load(id) {
      if (id !== `\0${entry}`) return;
      return `import React from "react";
        import {createRoot} from "react-dom/client";
        import {MemoryRouter} from "react-router";
        import {DndContext} from "@dnd-kit/core";
        import {Sidebar} from "/src/components/Sidebar.tsx";
        import {TooltipProvider} from "/src/components/ui/tooltip.tsx";
        import "/src/styles/global.css";
        const noop=()=>{};
        function Fixture(){
          const [linked,setLinked]=React.useState(true);
          return React.createElement(MemoryRouter,null,React.createElement(TooltipProvider,null,
            React.createElement(DndContext,null,React.createElement(Sidebar,{
              width:600,collapsed:false,isResizing:false,orderedTags:[{tag:"alpha",count:18}],
              channelPreviews:new Map(),totalBlocks:18,isDropDragging:false,isCreatingChannel:false,
              onSetCreatingChannel:noop,onDeleteTag:noop,onRenameTag:noop,onCreateChannel:noop,
              linkedBlockSlug:"audit",linkedTags:linked?["alpha"]:[],onToggleLinkedTag:()=>setLinked(!linked)
            }))));
        }
        createRoot(document.getElementById("root")).render(React.createElement(Fixture));`;
    },
    configureServer(vite) {
      vite.middlewares.use(async (req,res,next)=>{
        if(req.url!=="/__sidebar-action-audit") return next();
        res.setHeader("Content-Type","text/html");
        res.end(await vite.transformIndexHtml(req.url,`<html><body><div id="root" style="--sidebar-width:600px;height:600px"></div><script type="module" src="${entry}"></script></body></html>`));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser=await chromium.launch();
  for(const scale of [1,2]) {
    const page=await browser.newPage({viewport:{width:1000,height:700},deviceScaleFactor:scale});
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(new URL("/__sidebar-action-audit",server.resolvedUrls.local[0]).href);
    const button=page.getByRole("button",{name:/^(Disconnect|Connect) alpha$/});
    await button.waitFor();
    for(const design of ["default","alt","alt2"]) {
      await page.evaluate(design=>document.documentElement.dataset.design=design,design);
      let previous;
      for(const state of ["Connected","Disconnect","Connect"]) {
        if(state==="Connected") await page.mouse.move(900,650);
        else await button.hover();
        if(state==="Connect") await button.click();
        await page.waitForTimeout(250);
        const rect=await button.evaluate(el=>{
          const r=el.getBoundingClientRect(),row=el.closest('[data-sidebar-row]').getBoundingClientRect();
          const zone=parseFloat(getComputedStyle(el).getPropertyValue('--sidebar-zone'));
          return {width:r.width,height:r.height,left:r.left-(row.right-zone),right:row.right-r.right,top:r.top-row.top,bottom:row.bottom-r.bottom,text:el.innerText};
        });
        assert.equal(rect.text,state);
        for(const edge of ["left","right","top","bottom"]) assert.equal(rect[edge],8,`${design} ${scale}x ${state} ${edge}`);
        if(previous) assert.equal(rect.width,previous.width);
        previous=rect;
        console.log(`PASS ${design} ${scale}x ${state}: 8px on all four sides`);
      }
      await button.click();
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
