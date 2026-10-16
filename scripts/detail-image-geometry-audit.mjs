// The expanded card in headless Chromium. The image frame: the original
// replaces the preview without moving or resizing the frame, both layers fill
// it, and a smaller window keeps the proportion (SPEC_CARD_MEDIA_GEOMETRY.md).
// The layout (SPEC_FRONTEND.md, «Раскладка открытой карточки»): beside a
// sidebar the content stands centred between it and the panel, the view
// stacks when both margins reach the inset, the stacked panel cards are no
// wider than the reading column and centred, body media stand centred in the
// article's column, a video's box is its frame, a panel taller than the
// window scrolls to its last card, a link's page picture stands in the one
// media frame by its own proportion, and a picture whose record has a wrong
// size takes its own. Real layout, which the jsdom tests of Detail cannot
// measure.
// Starts and stops its own Vite.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {COLD_START_MS,startAuditVite} from './audit-vite.mjs';

const entry='/detail-image-geometry-entry.js';
// The sidebar beside the open card in the layout pages, and the window height
// (85 % of it, 680, is the media height limit). The reading column,
// `DETAIL_CONTENT_MAX_WIDTH_PX` (user's decision of 16.10.2026: 680 instead
// of 768). A window too short for the panel's cards.
const SIDEBAR=240,HEIGHT=800,LIMIT=0.85*HEIGHT,COLUMN=680,SHORT=400;
const vite=await startAuditVite([{
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
      const card=params.get('card');
      const width=Number(params.get('w')),height=Number(params.get('h'));
      window.__TAURI_INTERNALS__={convertFileSrc:path=>card?location.origin+'/media/'+encodeURIComponent(path.split('/').pop()):location.origin+'/image/'+(path.includes('thumbs')?'preview':'original'),invoke:async command=>{if(command==='get_block')return null;throw Error(command);}};
      const base={id:1,slug:'card',card_kind:'media',block_type:'image',title:'Card',display_title:'Card',fallback_label:'Card',description:null,url:null,media_file:null,thumbnail:null,saved_at:'2026-09-19T00:00:00Z',source:null,width:null,height:null,author:null,body:'',preview_text:null,first_image:null,media_urls:null,media_dimensions:null,preview_manifest:null,feed_playback:null,thumb_format:null,thumb_mtime:0,related_notes:[],tags:[]};
      const text='A line of the article that is long enough to fill the reading column from its left edge to its right edge. '.repeat(6);
      const cards={
        article:{...base,card_kind:'article',block_type:'article',url:'https://example.com/a',body:text+'\\n\\n![[tall.mp4]]\\n\\n'+text+'\\n\\n![[small.png]]\\n\\n'+text,preview_manifest:JSON.stringify({kind:'image',primary_preview_path:'card.jpg',tiles:[{source_path:'Media/tall.mp4',preview_path:'card.preview-1.jpg',width:1080,height:1920,is_video:true,is_video_poster:true},{source_path:'Media/small.png',preview_path:'card.preview-2.jpg',width:600,height:300,is_video:false,is_video_poster:false}]})},
        image:{...base,media_file:'Media/photo.png',width:880,height:1100},
        video:{...base,block_type:'video',media_file:'Media/tall.mp4',width:1080,height:1920},
        panel:{...base,card_kind:'article',block_type:'article',url:'https://example.com/p',author:'Author',body:text,related_notes:Array.from({length:16},(_,index)=>'Note '+(index+1))},
        link:{...base,card_kind:'link',block_type:'link',url:'https://example.com/l',title:'Page',display_title:'Page',description:'The page description.',thumbnail:'Media/og.png',preview_manifest:JSON.stringify({kind:'image',primary_preview_path:'link.jpg',tiles:[{source_path:'Media/og.png',is_video:false,is_video_poster:false}]})},
        wrong:{...base,media_file:'Media/wide.png',width:1077,height:1500},
      };
      const block=card?cards[card]:{...base,slug:'image',title:'Image',display_title:'Image',fallback_label:'Image',media_file:'image.jpg',width:params.has('legacy')?null:width,height:params.has('legacy')?null:height};
      const noop=()=>{};
      const detail=React.createElement(Detail,{block,vaultPath:'/vault',thumbsRootPath:'/thumbs',tags:[],onClose:noop,onToggleTag:noop,onCreateAndAssign:noop,onRequestRename:noop,onRequestDelete:noop});
      const shell=card?React.createElement('div',{style:{display:'flex',height:'100vh'}},React.createElement('aside',{'data-audit-sidebar':'',style:{width:'${SIDEBAR}px',flex:'none'}}),React.createElement('main',{style:{position:'relative',flex:'1',minWidth:0}},detail)):detail;
      createRoot(document.getElementById('root')).render(React.createElement(TooltipProvider,null,React.createElement(DndContext,null,shell)));`;
    },
    configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(!req.url.startsWith('/__detail-image-audit'))return next();
      res.setHeader('Content-Type','text/html');
      res.end(await server.transformIndexHtml(req.url,`<html><body><div id="root" style="height:100vh"></div><script type="module" src="${entry}"></script></body></html>`));
    });},
}]);

/** Same within a pixel: Chromium lays out in fractions of one. */
function near(actual,expected,message){assert(Math.abs(actual-expected)<=1,`${message}: ${actual} against ${expected}`);}

/** The open card's geometry as the reader sees it. */
async function measure(page){
  return page.evaluate(()=>{
    const box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const all=selector=>[...document.querySelectorAll(selector)].map(box);
    return {
      mode:document.querySelector('[data-detail-layout-mode]')?.getAttribute('data-detail-layout-mode'),
      pad:box(document.querySelector('[data-detail-pad-probe]')).width,
      main:box(document.querySelector('main')),
      column:box(document.querySelector('[data-detail-article-column]')),
      scroll:box(document.querySelector('[data-detail-scroll]')),
      panel:box(document.querySelector('[data-metadata-scroll]')),
      panelCards:all('[data-detail-panel-card]'),
      image:box(document.querySelector('[data-detail-image]')),
      bodyMedia:all('[data-article-media-stack] > [data-detail-media-action-frame]'),
      videos:[...document.querySelectorAll('[data-detail-video]')].map(frame=>({frame:box(frame),video:box(frame.querySelector('video'))})),
    };
  });
}

/** Beside the panel: `content` centred between the sidebar and the panel. */
function assertCentredBesidePanel(geometry,content,label){
  assert.equal(geometry.mode,'rail',`${label}: beside the panel`);
  const left=content.left-geometry.main.left,right=geometry.panel.left-content.right;
  near(left,right,`${label}: equal margins`);
  assert(Math.min(left,right)>=geometry.pad-1,`${label}: margins under the inset`);
  near(geometry.panel.right,geometry.main.right-geometry.pad,`${label}: panel an inset off the right edge`);
  return left;
}

/** Stacked: the content centred; under it the panel cards centred, as wide
 *  as the reading column, or across the width between the insets when that
 *  is narrower (Р4). Whether the reading column held them. */
function assertStacked(geometry,content,label){
  assert.equal(geometry.mode,'stacked',`${label}: stacked`);
  near(content.left-geometry.main.left,geometry.main.right-content.right,`${label}: content centred`);
  assert(geometry.panelCards.length>0,`${label}: panel cards under the content`);
  const between=geometry.main.width-2*geometry.pad,held=between>COLUMN;
  for(const card of geometry.panelCards){
    near(card.width,held?COLUMN:between,`${label}: panel card ${held?'as wide as the reading column':'across the width between the insets'}`);
    near(card.left-geometry.main.left,geometry.main.right-card.right,`${label}: panel card centred`);
  }
  return held;
}

/** A video's element is its frame, in its own proportion, under the limit. */
function assertVideoFillsFrame({frame,video},ratio,label){
  for(const side of ['left','top','width','height'])near(video[side],frame[side],`${label}: video ${side} equals its frame`);
  assert(Math.abs(frame.width/frame.height-ratio)<0.01,`${label}: frame proportion`);
  assert(frame.height<=LIMIT+0.5,`${label}: under the height limit`);
}

let browser;
try{
  browser=await chromium.launch({headless:true});
  for(const [width,height] of [[1600,1200],[1200,1600],[240,160]])for(const legacy of [false,true]){
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));    let release;const gate=new Promise(resolve=>release=resolve);
    await page.route('**/image/*',async route=>{
      const original=route.request().url().endsWith('original');
      if(original)await gate;
      const divisor=original?1:5;
      await route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width/divisor}" height="${height/divisor}"><rect width="100%" height="100%" fill="orange"/></svg>`});
    });
    await page.goto(new URL(`/__detail-image-audit?w=${width}&h=${height}${legacy?'&legacy=1':''}`,vite.origin).href,{waitUntil:'domcontentloaded'});
    const frame=page.locator('[data-detail-image]');
    await page.waitForFunction(()=>document.querySelector('[data-detail-preview-backing]')?.naturalWidth>0,null,{timeout:COLD_START_MS});
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

  // The layout. Each card at window widths round its threshold
  // 3 × pad + W + 320 + sidebar (pad 32): the reading column 680 (1336),
  // a picture 880 × 1100 at 544 (1200), a portrait video 1080 × 1920 at 383
  // (1039).
  const images={'photo.png':[880,1100],'small.png':[600,300],'link.jpg':[400,300],'wide.png':[1920,1080]};
  async function openCard(card,width,height=HEIGHT){
    const page=await browser.newPage({viewport:{width,height}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/media/*',async route=>{
      const name=decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
      // No video file is served: the frame's geometry comes from the record.
      if(name.endsWith('.mp4'))return route.fulfill({status:404,body:''});
      const [w,h]=images[name]??[64,64];
      await route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="orange"/></svg>`});
    });
    await page.goto(new URL(`/__detail-image-audit?card=${card}`,vite.origin).href,{waitUntil:'domcontentloaded'});
    await page.waitForSelector('[data-detail-layout-mode]',{timeout:COLD_START_MS});
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForTimeout(150);
    return {page,errors,async resize(next){await page.setViewportSize({width:next,height:HEIGHT});await page.waitForTimeout(150);return measure(page);}};
  }

  {
    const {page,errors,resize}=await openCard('article',1600);
    for(const width of [1600,1336,1335,900]){
      const geometry=await resize(width);
      const label=`article at ${width}`;
      if(width>=1336){
        const margin=assertCentredBesidePanel(geometry,geometry.column,label);
        if(width===1336)near(margin,geometry.pad,`${label}: margins at the inset on the last width beside the panel`);
      }else{
        // Stacked at 1335 the area is wider than the column, at 900 not.
        assert.equal(assertStacked(geometry,geometry.column,label),width===1335,`${label}: panel cards held by the reading column`);
      }
      assert.equal(geometry.bodyMedia.length,2,`${label}: both body media`);
      for(const media of geometry.bodyMedia)near(media.left-geometry.column.left,geometry.column.right-media.right,`${label}: body media centred in the column`);
      assert.equal(geometry.videos.length,1,`${label}: the body video`);
      assertVideoFillsFrame(geometry.videos[0],1080/1920,`${label} body video`);
      near(geometry.videos[0].frame.height,LIMIT,`${label}: portrait body video at the height limit`);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS article: centred beside the panel at 1600 and 1336, stacked at 1335 with panel cards 680 wide and centred and at 900 across the width between the insets, body media centred, body video box is its frame');
    await page.close();
  }

  {
    const {page,errors,resize}=await openCard('image',1600);
    for(const width of [1600,1200,1199]){
      const geometry=await resize(width);
      const label=`picture at ${width}`;
      near(geometry.image.width,544,`${label}: frame width at the height limit`);
      if(width>=1200){
        const margin=assertCentredBesidePanel(geometry,geometry.image,label);
        if(width===1200)near(margin,geometry.pad,`${label}: margins at the inset`);
      }else{
        assert(assertStacked(geometry,geometry.image,label),`${label}: panel cards held by the reading column`);
      }
    }
    assert.deepEqual(errors,[]);
    console.log('PASS picture: centred beside the panel at 1600 and 1200, stacked at 1199 with panel cards 680 wide and centred');
    await page.close();
  }

  {
    const {page,errors,resize}=await openCard('video',1600);
    for(const width of [1600,1039,1038]){
      const geometry=await resize(width);
      const label=`video at ${width}`;
      assert.equal(geometry.videos.length,1,`${label}: the card's video`);
      const [video]=geometry.videos;
      assertVideoFillsFrame(video,1080/1920,label);
      if(width>=1039){
        const margin=assertCentredBesidePanel(geometry,video.frame,label);
        if(width===1039)near(margin,geometry.pad,`${label}: margins at the inset`);
      }else{
        assert(assertStacked(geometry,video.frame,label),`${label}: panel cards held by the reading column`);
      }
    }
    assert.deepEqual(errors,[]);
    console.log('PASS video: box is its frame, centred beside the panel at 1600 and 1039, stacked at 1038 with panel cards 680 wide and centred');
    await page.close();
  }

  // A link's page picture (Р9): a 4:3 picture without a recorded size in the
  // one media frame at its own size, centred in the reading column, the
  // title under it, ⤢ at its corner; no 16:9 box.
  {
    const {page,errors}=await openCard('link',1600);
    await page.waitForFunction(()=>document.querySelector('[data-detail-link-picture] [data-detail-image]')?.style.aspectRatio==='400 / 300',null,{timeout:COLD_START_MS});
    await page.waitForTimeout(100);
    const geometry=await page.evaluate(()=>{
      const box=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const frame=document.querySelector('[data-detail-link-picture] [data-detail-image]');
      return {
        column:box(document.querySelector('[data-detail-article-column]')),
        frame:box(frame),
        image:box(frame.querySelector('img')),
        controls:box(document.querySelector('[data-detail-link-picture] [data-detail-media-action-menu]')),
        heading:box(document.querySelector('[data-detail-article-column] h2')),
        boxes:document.querySelectorAll('[data-detail-article-column] .aspect-video').length,
      };
    });
    assert.equal(geometry.boxes,0,'link: no 16:9 box');
    near(geometry.column.width,COLUMN,'link: holds the reading column');
    near(geometry.frame.width,400,'link: frame at the picture\'s own width');
    near(geometry.frame.height,300,'link: frame in the picture\'s own proportion');
    for(const side of ['left','top','width','height'])near(geometry.image[side],geometry.frame[side],`link: picture ${side} equals its frame`);
    near(geometry.frame.left-geometry.column.left,geometry.column.right-geometry.frame.right,'link: picture centred in the column');
    near(geometry.controls.right,geometry.frame.right-8,'link: ⤢ at the picture\'s right edge');
    near(geometry.controls.top,geometry.frame.top+8,'link: ⤢ at the picture\'s top edge');
    assert(geometry.heading.top>=geometry.frame.bottom-0.5,'link: the title under the picture');
    assert.deepEqual(errors,[]);
    console.log('PASS link: page picture 400 × 300 in its own frame, centred in the 680 column, ⤢ at its corner, title under it, no 16:9 box');
    await page.close();
  }

  // A record of 1077 × 1500 whose file is 1920 × 1080 (Р6): once the original
  // loads, the frame is 16:9, the content's width follows it (680 at the
  // height limit of a 800 tall window) and the controls stand at the
  // picture's corner, not over empty space.
  {
    const {page,errors}=await openCard('wrong',1600);
    await page.waitForFunction(()=>document.querySelector('[data-detail-image]')?.style.aspectRatio==='1920 / 1080',null,{timeout:COLD_START_MS});
    await page.waitForTimeout(150);
    const geometry=await measure(page);
    const controls=await page.evaluate(()=>{const r=document.querySelector('[data-detail-media-action-menu]').getBoundingClientRect();return {right:r.right,top:r.top};});
    near(geometry.image.width,COLUMN,'wrong size: frame as wide as the corrected content');
    assert(Math.abs(geometry.image.width/geometry.image.height-1920/1080)<0.01,'wrong size: frame in the picture\'s own proportion');
    assertCentredBesidePanel(geometry,geometry.image,'wrong size at 1600');
    near(controls.right,geometry.image.right-8,'wrong size: controls at the picture\'s right edge');
    near(controls.top,geometry.image.top+8,'wrong size: controls at the picture\'s top edge');
    assert.deepEqual(errors,[]);
    console.log('PASS wrong size: stored 1077 × 1500, loaded 1920 × 1080: frame 16:9 at 680, centred beside the panel, controls at the picture\'s corner');
    await page.close();
  }

  // The panel's own scroll (Р8): in a window too short for its cards the
  // column is as tall as the open card and scrolls under the pointer to its
  // last card.
  {
    const {page,errors}=await openCard('panel',1600,SHORT);
    await page.waitForFunction(()=>document.querySelectorAll('[data-related-note-item]').length===16,null,{timeout:COLD_START_MS});
    const rest=await measure(page);
    assert.equal(rest.mode,'rail','panel: beside the content');
    near(rest.panel.top,rest.scroll.top,'panel: from the top of the open card');
    near(rest.panel.bottom,rest.scroll.bottom,'panel: down to its bottom, no lower');
    const [first]=rest.panelCards,last=rest.panelCards.at(-1);
    assert(last.bottom>rest.panel.bottom,`panel: the last card under the bottom edge at rest (${last.bottom} against ${rest.panel.bottom})`);
    await page.mouse.move(first.left+first.width/2,first.top+first.height/2);
    for(let turn=0;turn<10;turn+=1){
      await page.mouse.wheel(0,400);
      if(await page.evaluate(()=>{const node=document.querySelector('[data-metadata-scroll]');return node.scrollTop+node.clientHeight>=node.scrollHeight-1;}))break;
      await page.waitForTimeout(50);
    }
    await page.waitForFunction(()=>{const node=document.querySelector('[data-metadata-scroll]');return node.scrollTop>0&&node.scrollTop+node.clientHeight>=node.scrollHeight-1;},null,{timeout:5000});
    // The last card may be taller than the window: its end is what must
    // come into view, and the pointer must reach what shows of it.
    const end=await measure(page),lastAtEnd=end.panelCards.at(-1);
    assert(lastAtEnd.bottom>end.panel.top&&lastAtEnd.bottom<=end.panel.bottom,`panel: the end of the last card in view at the end (${lastAtEnd.bottom} in ${end.panel.top} to ${end.panel.bottom})`);
    assert(await page.evaluate(()=>{
      const last=[...document.querySelectorAll('[data-detail-panel-card]')].at(-1),box=last.getBoundingClientRect();
      const top=Math.max(box.top,document.querySelector('[data-metadata-scroll]').getBoundingClientRect().top);
      return last.contains(document.elementFromPoint(box.left+box.width/2,(top+box.bottom)/2));
    }),'panel: the pointer reaches the last card');
    assert.deepEqual(errors,[]);
    console.log(`PASS panel: at 1600 × ${SHORT} the column is the open card's height and scrolls under the pointer to its last card`);
    await page.close();
  }
}finally{await browser?.close();await vite.close();}
