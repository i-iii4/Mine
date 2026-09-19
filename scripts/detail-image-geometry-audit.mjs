import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const entry='/detail-image-geometry-entry.js';
const server=await createServer({
  root:fileURLToPath(new URL('..',import.meta.url)),
  server:{host:'127.0.0.1',port:0,hmr:false,open:false},
  plugins:[{
    name:'detail-image-geometry-audit',
    resolveId(id){if(id===entry)return `\0${entry}`;},
    load(id){if(id!==`\0${entry}`)return;return `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Detail} from '/src/components/Detail.tsx';
      import {DndContext} from '@dnd-kit/core';
      import {TooltipProvider} from '/src/components/ui/tooltip.tsx';
      import '/src/styles/global.css';
      const params=new URLSearchParams(location.search);
      const width=Number(params.get('w')),height=Number(params.get('h'));
      window.__TAURI_INTERNALS__={convertFileSrc:path=>location.origin+'/image/'+(path.includes('thumbs')?'preview':'original'),invoke:async command=>{if(command==='get_block')return null;throw Error(command);}};
      const block={id:1,slug:'image',card_kind:'media',block_type:'image',title:'Image',display_title:'Image',fallback_label:'Image',description:null,url:null,media_file:'image.jpg',thumbnail:null,saved_at:'2026-09-19T00:00:00Z',source:null,width:params.has('legacy')?null:width,height:params.has('legacy')?null:height,author:null,body:'',preview_text:null,first_image:null,media_urls:null,media_dimensions:null,preview_manifest:null,feed_playback:null,thumb_format:null,thumb_mtime:0,related_notes:[],tags:[]};
      const noop=()=>{};
      createRoot(document.getElementById('root')).render(React.createElement(TooltipProvider,null,React.createElement(DndContext,null,React.createElement(Detail,{block,vaultPath:'/vault',thumbsRootPath:'/thumbs',tags:[],onClose:noop,onToggleTag:noop,onCreateAndAssign:noop,onRequestRename:noop,onRequestDelete:noop}))));`;
    },
    configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
      if(!req.url.startsWith('/__detail-image-audit'))return next();
      res.setHeader('Content-Type','text/html');
      res.end(await vite.transformIndexHtml(req.url,`<html><body><div id="root" style="height:100vh"></div><script type="module" src="${entry}"></script></body></html>`));
    });},
  }],
});
let browser;
try{
  await server.listen();browser=await chromium.launch();
  for(const [width,height] of [[1600,1200],[1200,1600],[240,160]])for(const legacy of [false,true]){
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let release;const gate=new Promise(resolve=>release=resolve);
    await page.route('**/image/*',async route=>{
      const original=route.request().url().endsWith('original');
      if(original)await gate;
      const divisor=original?1:5;
      await route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width/divisor}" height="${height/divisor}"><rect width="100%" height="100%" fill="orange"/></svg>`});
    });
    await page.goto(new URL(`/__detail-image-audit?w=${width}&h=${height}${legacy?'&legacy=1':''}`,server.resolvedUrls.local[0]).href,{waitUntil:'domcontentloaded'});
    const frame=page.locator('[data-detail-image]');
    await page.waitForFunction(()=>document.querySelector('[data-detail-preview-backing]')?.naturalWidth>0);
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForTimeout(100);
    const before=await frame.boundingBox();
    assert(before.width>0&&before.height>0);
    release();
    await page.locator('[data-detail-preview-backing]').waitFor({state:'detached'});
    assert.deepEqual(await frame.boundingBox(),before,'original load must not move or resize the frame');
    const original=frame.locator('img');
    assert.deepEqual(await original.boundingBox(),before,'both layers fill the same frame');
    await page.setViewportSize({width:904,height:600});
    await page.waitForTimeout(100);
    const resized=await frame.boundingBox();
    assert(resized.width>0&&resized.height<=510.1);
    assert(Math.abs(resized.width/resized.height-width/height)<0.01);
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}x${height} ${legacy?'legacy':'metadata'}: stable swap, contain, resize`);
    await page.close();
  }
}finally{await browser?.close();await server.close();}
