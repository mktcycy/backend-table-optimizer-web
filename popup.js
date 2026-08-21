const LIMIT_BYTES = 65536;
const SAFE_BYTES = 60000;
const STORAGE_KEY = "backendTableOptimizerWebState";
const DEFAULT_COLUMN_WIDTH = 150;
const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 1200;

const DEFAULT_STYLE = {
  tableWidth: 1000,
  tableWidthUnit: "px",
  headerBg: "#EAF4FF",
  headerText: "#168CFF",
  bodyBg: "#FFFFFF",
  bodyText: "#111111",
  borderColor: "#222222",
  fontSize: 14,
  textAlign: "center",
  cellPadding: 4
};

let rows = blankMatrix(4, 4);
let merges = [];
let selection = null;
let pendingMatrix = null;
let pendingMerges = [];
let styleSettings = {...DEFAULT_STYLE};
let columnWidths = Array(4).fill(DEFAULT_COLUMN_WIDTH);
let storageAvailable = true;

const $ = id => document.getElementById(id);

function blankMatrix(r, c){
  return Array.from({length:r}, () => Array.from({length:c}, () => ""));
}

function esc(v){
  return String(v ?? "").replace(/[&<>\"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
}

function breakLongSeparatorRuns(v){
  return String(v ?? "").replace(/[‐‑‒–—―_＿─━═⎯-]{6,}/g, run => run.replace(/(.{4})(?=.)/g, "$1\u200B"));
}

function textWithBreaks(v){
  const lines=String(v ?? "").replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").split("\n");
  const separatorLine=/^[‐‑‒–—―_＿─━═⎯-]{6,}$/;
  return lines.map((line,index)=>{
    const divider=separatorLine.test(line.trim());
    const previousDivider=index>0&&separatorLine.test(lines[index-1].trim());
    const prefix=index>0&&!divider&&!previousDivider?"<br>":"";
    return divider?'<span style="display:block;border-top:1px solid;margin:3px 0"></span>':prefix+esc(breakLongSeparatorRuns(line));
  }).join("");
}

function normalizeHex(v, fallback){
  const s = String(v || "").trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : fallback.toLowerCase();
}

function clampWidth(v){
  return Math.max(200, Math.min(1000, Number(v) || 1000));
}

function clampPercentWidth(v){
  return Math.max(10,Math.min(100,Number(v)||100));
}

function formatPercent(v){
  return Number(Number(v||0).toFixed(1)).toString();
}

function columnWidthTotal(){
  return columnWidths.reduce((sum,width)=>sum+width,0)||1;
}

function columnPercentage(ci){
  return columnWidths[ci]/columnWidthTotal()*100;
}

function selectedPercentage(indexes){
  const selectedTotal=indexes.reduce((sum,ci)=>sum+columnWidths[ci],0);
  return selectedTotal/columnWidthTotal()*100;
}

function displayedColumnPercentages(){
  const total=columnWidthTotal();
  let remaining=1000;
  return columnWidths.map((width,index)=>{
    if (index===columnWidths.length-1) return remaining/10;
    const columnsAfter=columnWidths.length-index-1;
    const units=Math.max(1,Math.min(remaining-columnsAfter,Math.round(1000*width/total)));
    remaining-=units;
    return units/10;
  });
}

function selectedPercentageBounds(indexes){
  if (indexes.length===columnWidths.length) return {min:100,max:100};
  const total=columnWidthTotal();
  const selectedCount=indexes.length;
  const otherCount=columnWidths.length-selectedCount;
  const minTarget=Math.max(selectedCount*MIN_COLUMN_WIDTH,total-otherCount*MAX_COLUMN_WIDTH);
  const maxTarget=Math.min(selectedCount*MAX_COLUMN_WIDTH,total-otherCount*MIN_COLUMN_WIDTH);
  const min=Math.max(1,Math.ceil(minTarget/total*1000)/10);
  const max=Math.min(99,Math.floor(maxTarget/total*1000)/10);
  return {min:Math.min(min,max),max:Math.max(min,max)};
}

function clampColumnWidth(v){
  return Math.max(MIN_COLUMN_WIDTH,Math.min(MAX_COLUMN_WIDTH,Math.round(Number(v)||DEFAULT_COLUMN_WIDTH)));
}

function textDisplayUnits(value){
  return [...String(value??"")].reduce((sum,ch)=>sum+(/[\u2e80-\u9fff\uff00-\uffef]/.test(ch)?2:1),0);
}

function estimateColumnWidth(matrix,ci){
  let longest=0;
  matrix.forEach(row=>String(row?.[ci]??"").split(/\r?\n/).forEach(line=>{longest=Math.max(longest,textDisplayUnits(line));}));
  return clampColumnWidth(Math.max(100,Math.min(360,longest*7+34)));
}

function autoColumnWidths(matrix){
  const width=Math.max(1,...matrix.map(row=>row?.length||0));
  return Array.from({length:width},(_,ci)=>estimateColumnWidth(matrix,ci));
}

function ensureShape(){
  if (!Array.isArray(rows) || !rows.length) rows = [[""]];
  const width = Math.max(1, ...rows.map(r => Array.isArray(r) ? r.length : 0));
  rows = rows.map(r => Array.from({length:width}, (_,i) => String((r || [])[i] ?? "")));
  columnWidths = Array.from({length:width},(_,i)=>clampColumnWidth(columnWidths?.[i]??DEFAULT_COLUMN_WIDTH));
  merges = (merges || []).filter(m => m && Number.isInteger(m.r) && Number.isInteger(m.c) && Number.isInteger(m.rowspan) && Number.isInteger(m.colspan) && m.r >= 0 && m.c >= 0 && m.rowspan >= 1 && m.colspan >= 1 && m.r + m.rowspan <= rows.length && m.c + m.colspan <= width);
}

function mergeContaining(r,c){
  return merges.find(m => r >= m.r && r < m.r + m.rowspan && c >= m.c && c < m.c + m.colspan) || null;
}
function isTopLeft(m,r,c){ return !!m && m.r === r && m.c === c; }

function normalizedSelection(){
  if (!selection?.anchor || !selection?.focus) return null;
  return {
    r1:Math.min(selection.anchor.r,selection.focus.r),
    r2:Math.max(selection.anchor.r,selection.focus.r),
    c1:Math.min(selection.anchor.c,selection.focus.c),
    c2:Math.max(selection.anchor.c,selection.focus.c)
  };
}

function selectionIntersects(r,c,rowspan=1,colspan=1){
  const s = normalizedSelection();
  if (!s) return false;
  return !(r + rowspan - 1 < s.r1 || r > s.r2 || c + colspan - 1 < s.c1 || c > s.c2);
}

function colName(n){
  let s=""; n++;
  while(n){ n--; s=String.fromCharCode(65+n%26)+s; n=Math.floor(n/26); }
  return s;
}

function updateSelectionInfo(){
  const s = normalizedSelection();
  if (!s){ $("selectionInfo").textContent = "未選取儲存格"; updateColumnWidthControls(); return; }
  const start = `${colName(s.c1)}${s.r1+1}`;
  const end = `${colName(s.c2)}${s.r2+1}`;
  $("selectionInfo").textContent = start === end ? `已選 ${start}` : `已選 ${start} ～ ${end}`;
  updateColumnWidthControls();
}

function selectCell(r,c,shift=false){
  const m = mergeContaining(r,c);
  if (m){ r = m.r; c = m.c; }
  if (shift && selection?.anchor) selection = {anchor:selection.anchor,focus:{r,c}};
  else selection = {anchor:{r,c},focus:{r,c}};
  updateSelectionStyles();
  updateSelectionInfo();
}

function updateSelectionStyles(){
  $("editGrid").querySelectorAll("td[data-row][data-col]").forEach(td => {
    const r = Number(td.dataset.row), c = Number(td.dataset.col);
    td.classList.toggle("selected", selectionIntersects(r,c,Number(td.rowSpan||1),Number(td.colSpan||1)));
  });
}

function selectedColumnIndexes(){
  const s=normalizedSelection();
  if (!s) return [];
  return Array.from({length:s.c2-s.c1+1},(_,i)=>s.c1+i);
}

function updateColumnWidthControls(){
  const indexes=selectedColumnIndexes();
  const input=$("selectedColWidth");
  const controlled=["selectedColWidth","colWidthDecrease","colWidthIncrease","fitSelectedCols"].map($);
  const disabled=!indexes.length;
  controlled.forEach(el=>{el.disabled=disabled;});
  if (disabled){
    input.value="";
    input.placeholder="比例";
    input.min="1";
    input.max="100";
    $("columnWidthHint").textContent="先選一格或點欄標題，可輸入百分比或拖曳欄標題右側把手。";
    return;
  }
  const percent=selectedPercentage(indexes);
  const bounds=selectedPercentageBounds(indexes);
  input.min=formatPercent(bounds.min);
  input.max=formatPercent(bounds.max);
  input.value=formatPercent(percent);
  input.placeholder="比例";
  const range=indexes.length===1?`${colName(indexes[0])} 欄`:`${colName(indexes[0])}～${colName(indexes.at(-1))} 欄`;
  const combined=indexes.length>1?"合計 ":"";
  $("columnWidthHint").textContent=`已選 ${range}，目前${combined}${formatPercent(percent)}%。其餘欄位會自動重新分配。`;
}

function applyEditorColumnWidths(){
  const table=$("editGrid");
  const percentages=displayedColumnPercentages();
  table.style.width=`${44+Math.round(columnWidths.reduce((sum,width)=>sum+width,0))}px`;
  table.querySelectorAll("col[data-col]").forEach(col=>{
    const ci=Number(col.dataset.col);
    col.style.width=`${Math.round(columnWidths[ci])}px`;
  });
  table.querySelectorAll(".col-head[data-col]").forEach(th=>{
    const ci=Number(th.dataset.col);
    const label=th.querySelector(".col-width-value");
    if (label) label.textContent=`${formatPercent(percentages[ci])}%`;
  });
}

function finishColumnWidthChange(message){
  applyEditorColumnWidths();
  updateColumnWidthControls();
  renderPreview();
  saveState();
  if (message) setStatus(message);
}

function applyPercentageToSelected(value){
  const indexes=selectedColumnIndexes();
  if (!indexes.length) return setStatus("請先選取要調整的欄。",true);
  const bounds=selectedPercentageBounds(indexes);
  const percent=Math.max(bounds.min,Math.min(bounds.max,Number(value)||bounds.min));
  if (indexes.length===columnWidths.length){
    updateColumnWidthControls();
    return setStatus("全部欄位的合計比例固定為 100%。");
  }
  const selectedSet=new Set(indexes);
  const total=columnWidthTotal();
  const currentSelected=indexes.reduce((sum,ci)=>sum+columnWidths[ci],0)||1;
  const currentOthers=Math.max(1,total-currentSelected);
  const targetSelected=total*percent/100;
  const targetOthers=total-targetSelected;
  columnWidths=columnWidths.map((width,ci)=>selectedSet.has(ci)?width*targetSelected/currentSelected:width*targetOthers/currentOthers);
  const range=indexes.length===1?`${colName(indexes[0])} 欄`:`${colName(indexes[0])}～${colName(indexes.at(-1))} 欄`;
  finishColumnWidthChange(`已將 ${range}比例設為 ${formatPercent(percent)}%`);
}

function stepSelectedPercentages(delta){
  const indexes=selectedColumnIndexes();
  if (!indexes.length) return setStatus("請先選取要調整的欄。",true);
  applyPercentageToSelected(selectedPercentage(indexes)+delta);
}

function fitSelectedColumns(){
  const indexes=selectedColumnIndexes();
  if (!indexes.length) return setStatus("請先選取要依內容調整的欄。",true);
  indexes.forEach(ci=>{columnWidths[ci]=estimateColumnWidth(rows,ci);});
  finishColumnWidthChange(`已依內容重新估算 ${indexes.length} 欄比例`);
}

function equalizeColumns(){
  columnWidths=columnWidths.map(()=>DEFAULT_COLUMN_WIDTH);
  finishColumnWidthChange(`已平均分配全部欄寬（每欄 ${formatPercent(100/rows[0].length)}%）`);
}

function beginColumnResize(event,ci,handle){
  event.preventDefault();
  event.stopPropagation();
  selection={anchor:{r:0,c:ci},focus:{r:rows.length-1,c:ci}};
  updateSelectionStyles();
  updateSelectionInfo();
  const startX=event.clientX;
  const startWidth=columnWidths[ci];
  handle.classList.add("dragging");
  const move=moveEvent=>{
    columnWidths[ci]=clampColumnWidth(startWidth+moveEvent.clientX-startX);
    applyEditorColumnWidths();
    updateColumnWidthControls();
  };
  const finish=()=>{
    document.removeEventListener("pointermove",move);
    document.removeEventListener("pointerup",finish);
    document.removeEventListener("pointercancel",finish);
    handle.classList.remove("dragging");
    const percent=formatPercent(displayedColumnPercentages()[ci]);
    handle.setAttribute("aria-label",`調整 ${colName(ci)} 欄寬度，目前 ${percent}%`);
    finishColumnWidthChange(`${colName(ci)} 欄寬度已設為 ${percent}%`);
  };
  document.addEventListener("pointermove",move);
  document.addEventListener("pointerup",finish);
  document.addEventListener("pointercancel",finish);
}

function renderGrid(){
  ensureShape();
  const table = $("editGrid");
  table.innerHTML = "";
  const width = rows[0].length;
  const displayedPercentages=displayedColumnPercentages();

  const colgroup=document.createElement("colgroup");
  const rowNumberCol=document.createElement("col");
  rowNumberCol.style.width="44px";
  colgroup.appendChild(rowNumberCol);
  for(let ci=0;ci<width;ci++){
    const col=document.createElement("col");
    col.dataset.col=ci;
    col.style.width=`${Math.round(columnWidths[ci])}px`;
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  const headerTr = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "corner-head";
  corner.textContent = "";
  headerTr.appendChild(corner);
  for (let ci=0; ci<width; ci++){
    const th = document.createElement("th");
    th.className = "col-head";
    th.dataset.col=ci;
    th.title = `第 ${ci+1} 欄（點擊可選整欄）`;
    const headContent=document.createElement("div");
    headContent.className="col-head-content";
    const colTitle=document.createElement("span");
    colTitle.className="col-title";
    colTitle.textContent=colName(ci);
    const widthValue=document.createElement("span");
    widthValue.className="col-width-value";
    widthValue.textContent=`${formatPercent(displayedPercentages[ci])}%`;
    headContent.append(colTitle,widthValue);
    const resizer=document.createElement("span");
    resizer.className="col-resizer";
    resizer.tabIndex=0;
    resizer.setAttribute("role","separator");
    resizer.setAttribute("aria-orientation","vertical");
    resizer.setAttribute("aria-label",`調整 ${colName(ci)} 欄寬度，目前 ${formatPercent(displayedPercentages[ci])}%`);
    resizer.addEventListener("pointerdown",event=>beginColumnResize(event,ci,resizer));
    resizer.addEventListener("click",event=>event.stopPropagation());
    resizer.addEventListener("keydown",event=>{
      if (!["ArrowLeft","ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      selection={anchor:{r:0,c:ci},focus:{r:rows.length-1,c:ci}};
      updateSelectionStyles();
      updateSelectionInfo();
      applyPercentageToSelected(columnPercentage(ci)+(event.key==="ArrowRight"?1:-1));
      resizer.setAttribute("aria-label",`調整 ${colName(ci)} 欄寬度，目前 ${formatPercent(displayedColumnPercentages()[ci])}%`);
    });
    th.append(headContent,resizer);
    th.addEventListener("click", event => {
      if (event.shiftKey && selection?.anchor){
        selection={anchor:{r:0,c:selection.anchor.c},focus:{r:rows.length-1,c:ci}};
      }else selection = {anchor:{r:0,c:ci},focus:{r:rows.length-1,c:ci}};
      updateSelectionStyles(); updateSelectionInfo();
    });
    headerTr.appendChild(th);
  }
  thead.appendChild(headerTr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((row,ri) => {
    const tr = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.className = "row-head";
    rowHead.textContent = String(ri+1);
    rowHead.title = `第 ${ri+1} 列（點擊可選整列）`;
    rowHead.addEventListener("click", () => {
      selection = {anchor:{r:ri,c:0},focus:{r:ri,c:width-1}};
      updateSelectionStyles(); updateSelectionInfo();
    });
    tr.appendChild(rowHead);

    for (let ci=0; ci<width; ci++){
      const m = mergeContaining(ri,ci);
      if (m && !isTopLeft(m,ri,ci)) continue;
      const td = document.createElement("td");
      td.dataset.row = ri;
      td.dataset.col = ci;
      if (m){
        td.rowSpan = m.rowspan;
        td.colSpan = m.colspan;
        td.classList.add("merged");
      }
      const input = document.createElement("textarea");
      input.value = row[ci] ?? "";
      input.rows = Math.max(1, Math.min(8, String(input.value).split(/\r?\n/).length));
      input.addEventListener("mousedown", e => selectCell(ri,ci,!!e.shiftKey));
      input.addEventListener("input", e => {
        rows[ri][ci] = e.target.value;
        e.target.rows = Math.max(1, Math.min(8, String(e.target.value).split(/\r?\n/).length));
        renderPreview(); saveState();
      });
      td.addEventListener("click", e => selectCell(ri,ci,!!e.shiftKey));
      td.appendChild(input);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  applyEditorColumnWidths();
  updateSelectionStyles();
  updateSelectionInfo();
}

function mergeSelection(){
  ensureShape();
  const s = normalizedSelection();
  if (!s) return setStatus("請先選取要合併的範圍。", true);
  const rowspan = s.r2-s.r1+1, colspan = s.c2-s.c1+1;
  if (rowspan === 1 && colspan === 1) return setStatus("請先點第一格，再按住 Shift 點最後一格。", true);
  const intersectsExisting = merges.some(m => !(m.r+m.rowspan-1 < s.r1 || m.r > s.r2 || m.c+m.colspan-1 < s.c1 || m.c > s.c2));
  if (intersectsExisting) return setStatus("選取範圍包含既有合併，請先取消合併。", true);
  merges.push({r:s.r1,c:s.c1,rowspan,colspan});
  selection = {anchor:{r:s.r1,c:s.c1},focus:{r:s.r1,c:s.c1}};
  renderGrid(); renderPreview(); saveState();
  setStatus(`已合併 ${rowspan} 列 × ${colspan} 欄`);
}

function unmergeSelection(){
  const point = selection?.anchor;
  if (!point) return setStatus("請先點選已合併的儲存格。", true);
  const m = mergeContaining(point.r,point.c);
  if (!m) return setStatus("目前選取格沒有合併。", true);
  merges = merges.filter(x => x !== m);
  selection = {anchor:{r:m.r,c:m.c},focus:{r:m.r,c:m.c}};
  renderGrid(); renderPreview(); saveState(); setStatus("已取消合併");
}

function insertRows(at,count=1){
  ensureShape();
  at = Math.max(0, Math.min(rows.length, at));
  const width = rows[0].length;
  rows.splice(at,0,...Array.from({length:count},()=>Array.from({length:width},()=>"")));
  merges = merges.map(m=>{
    const end = m.r + m.rowspan;
    if (at <= m.r) return {...m,r:m.r+count};
    if (at < end) return {...m,rowspan:m.rowspan+count};
    return m;
  });
}

function insertCols(at,count=1){
  ensureShape();
  at = Math.max(0, Math.min(rows[0].length, at));
  const inheritedWidth=columnWidths[Math.max(0,Math.min(columnWidths.length-1,at-1))]??DEFAULT_COLUMN_WIDTH;
  rows.forEach(r=>r.splice(at,0,...Array.from({length:count},()=>"")));
  columnWidths.splice(at,0,...Array.from({length:count},()=>inheritedWidth));
  merges = merges.map(m=>{
    const end = m.c + m.colspan;
    if (at <= m.c) return {...m,c:m.c+count};
    if (at < end) return {...m,colspan:m.colspan+count};
    return m;
  });
}

function deleteRows(r1,r2){
  ensureShape();
  r1=Math.max(0,r1); r2=Math.min(rows.length-1,r2);
  if (r1>r2) return;
  const count=r2-r1+1;
  if (count>=rows.length) return setStatus("至少保留 1 列。",true);
  const saved = merges.map(m=>({m:{...m},value:rows[m.r]?.[m.c]??""}));
  rows.splice(r1,count);
  const next=[];
  saved.forEach(({m,value})=>{
    const start=m.r,end=m.r+m.rowspan-1;
    if (end<r1){ next.push(m); return; }
    if (start>r2){ next.push({...m,r:m.r-count}); return; }
    const top=Math.max(0,r1-start);
    const bottom=Math.max(0,end-r2);
    const span=top+bottom;
    if (span<=0) return;
    const nr=start<r1?start:r1;
    const nm={...m,r:nr,rowspan:span};
    next.push(nm);
    if (rows[nm.r] && rows[nm.r][nm.c]==="") rows[nm.r][nm.c]=value;
  });
  merges=next;
}

function deleteCols(c1,c2){
  ensureShape();
  c1=Math.max(0,c1); c2=Math.min(rows[0].length-1,c2);
  if (c1>c2) return;
  const count=c2-c1+1;
  if (count>=rows[0].length) return setStatus("至少保留 1 欄。",true);
  const saved = merges.map(m=>({m:{...m},value:rows[m.r]?.[m.c]??""}));
  rows.forEach(r=>r.splice(c1,count));
  columnWidths.splice(c1,count);
  const next=[];
  saved.forEach(({m,value})=>{
    const start=m.c,end=m.c+m.colspan-1;
    if (end<c1){ next.push(m); return; }
    if (start>c2){ next.push({...m,c:m.c-count}); return; }
    const left=Math.max(0,c1-start);
    const right=Math.max(0,end-c2);
    const span=left+right;
    if (span<=0) return;
    const nc=start<c1?start:c1;
    const nm={...m,c:nc,colspan:span};
    next.push(nm);
    if (rows[nm.r] && rows[nm.r][nm.c]==="") rows[nm.r][nm.c]=value;
  });
  merges=next;
}

function afterStructureChange(msg,newCell){
  ensureShape();
  selection = newCell ? {anchor:newCell,focus:newCell} : null;
  renderGrid();renderPreview();saveState();setStatus(msg);
}

function selectedOrLast(){
  const s=normalizedSelection();
  if (s){
    if (s.r1===s.r2 && s.c1===s.c2){
      const m=mergeContaining(s.r1,s.c1);
      if (m) return {r1:m.r,r2:m.r+m.rowspan-1,c1:m.c,c2:m.c+m.colspan-1};
    }
    return s;
  }
  return {r1:rows.length-1,r2:rows.length-1,c1:rows[0].length-1,c2:rows[0].length-1};
}

function compactFontFamily(){
  return 'Arial,Microsoft JhengHei,sans-serif';
}

function buildHtml(){
  ensureShape();
  const hbg = normalizeHex(styleSettings.headerBg, DEFAULT_STYLE.headerBg);
  const htx = normalizeHex(styleSettings.headerText, DEFAULT_STYLE.headerText);
  const bbg = normalizeHex(styleSettings.bodyBg, DEFAULT_STYLE.bodyBg);
  const btx = normalizeHex(styleSettings.bodyText, DEFAULT_STYLE.bodyText);
  const bc = normalizeHex(styleSettings.borderColor, DEFAULT_STYLE.borderColor);
  const size = Math.max(10,Math.min(24,Number(styleSettings.fontSize)||14));
  const pad = Math.max(0,Math.min(20,Number(styleSettings.cellPadding)||4));
  const align = ["left","right","center"].includes(styleSettings.textAlign) ? styleSettings.textAlign : "center";
  const percentMode=styleSettings.tableWidthUnit==="percent";
  const tableWidth=percentMode?clampPercentWidth(styleSettings.tableWidth):clampWidth(styleSettings.tableWidth);
  const tableWidthToken=`${formatPercent(tableWidth)}${percentMode?"%":"px"}`;
  const tableWidthAttr=percentMode?`${formatPercent(tableWidth)}%`:String(tableWidth);
  const firstHeader = $("firstHeader").checked;
  const widthTotal=columnWidths.reduce((sum,width)=>sum+width,0)||1;
  const scaleTotal=percentMode?1000:tableWidth;
  let remainingWidth=scaleTotal;
  const scaledWidths=columnWidths.map((width,index)=>{
    const columnsAfter=columnWidths.length-index-1;
    if (!columnsAfter) return Math.max(1,remainingWidth);
    const scaled=Math.max(1,Math.min(remainingWidth-columnsAfter,Math.round(scaleTotal*width/widthTotal)));
    remainingWidth-=scaled;
    return scaled;
  });
  const widthAttr=value=>percentMode?`${formatPercent(value/10)}%`:String(value);
  const widthCss=value=>percentMode?`${formatPercent(value/10)}%`:`${value}px`;

  // 精簡輸出：共用樣式只寫一次，降低 65,536 Byte 壓力。
  let html = `<table border=1 cellspacing=0 cellpadding=${pad} width="${tableWidthAttr}" bordercolor=${bc} bgcolor=${bbg} style="width:${tableWidthToken};max-width:100%;margin:auto;border-collapse:collapse;table-layout:fixed;overflow-wrap:anywhere;word-break:break-all;text-align:${align};color:${btx};font:${size}px ${compactFontFamily()}">`;
  html += `<colgroup>${scaledWidths.map(width=>`<col width="${widthAttr(width)}" style="width:${widthCss(width)}">`).join("")}</colgroup>`;
  for (let ri=0; ri<rows.length; ri++){
    const headerRow = firstHeader && ri === 0;
    html += headerRow ? `<tr bgcolor=${hbg} style="color:${htx};font-weight:700">` : `<tr>`;
    for (let ci=0; ci<rows[0].length; ci++){
      const m = mergeContaining(ri,ci);
      if (m && !isTopLeft(m,ri,ci)) continue;
      const tag = headerRow ? "th" : "td";
      let attrs = "";
      if (m?.rowspan > 1) attrs += ` rowspan=${m.rowspan}`;
      if (m?.colspan > 1) attrs += ` colspan=${m.colspan}`;
      // 舊式後台可能移除 colgroup；首列再寫一份寬度，避免貼上後變成平均欄寬。
      if (ri === 0){
        const span=m?.colspan||1;
        const cellWidth=scaledWidths.slice(ci,ci+span).reduce((sum,width)=>sum+width,0);
        attrs += ` width="${widthAttr(cellWidth)}" style="width:${widthCss(cellWidth)}"`;
      }
      html += `<${tag}${attrs}>${textWithBreaks(rows[ri][ci])}</${tag}>`;
    }
    html += `</tr>`;
  }
  html += `</table>`;
  return html;
}

function plainText(){
  ensureShape();
  return rows.map(r => r.join("\t")).join("\n");
}

function byteLength(s){ return new TextEncoder().encode(String(s)).length; }

function updateByteMeter(html){
  const bytes = byteLength(html);
  const pct = Math.min(100, bytes / LIMIT_BYTES * 100);
  $("byteText").textContent = `${bytes.toLocaleString()} / ${LIMIT_BYTES.toLocaleString()} Byte`;
  $("byteBar").style.width = `${pct}%`;
  if (bytes > LIMIT_BYTES){
    $("byteBar").style.background = "#d92d20";
    $("byteHint").textContent = `超出 ${(bytes-LIMIT_BYTES).toLocaleString()} Byte。請減少列／欄、文字內容或不必要的格式。`;
    $("byteHint").style.color = "#d92d20";
  } else if (bytes > SAFE_BYTES){
    $("byteBar").style.background = "#f59e0b";
    $("byteHint").textContent = `接近上限，剩餘 ${(LIMIT_BYTES-bytes).toLocaleString()} Byte。建議預留後台編輯器額外標記空間。`;
    $("byteHint").style.color = "#b54708";
  } else {
    $("byteBar").style.background = "#12b76a";
    $("byteHint").textContent = `尚餘 ${(LIMIT_BYTES-bytes).toLocaleString()} Byte；目前使用精簡 HTML 輸出。`;
    $("byteHint").style.color = "#667085";
  }
  return bytes;
}

function renderPreview(){
  const html = buildHtml();
  $("preview").innerHTML = html;
  updateByteMeter(html);
}

function currentState(){
  return {
    schemaVersion:13,
    rows,
    merges,
    columnWidths,
    firstHeader:$("firstHeader").checked,
    styleSettings
  };
}

function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY,JSON.stringify(currentState()));
  }catch(err){
    if (storageAvailable){
      storageAvailable=false;
      setStatus("瀏覽器無法儲存目前內容；關閉頁面前請先複製表格。",true);
    }
  }
}

function updateTableWidthUi(){
  const input=$("tableWidth");
  const percentMode=$("tableWidthUnit").value==="percent";
  input.min=percentMode?"10":"200";
  input.max=percentMode?"100":"1000";
  input.step=percentMode?"5":"50";
  const value=percentMode?clampPercentWidth(input.value):clampWidth(input.value);
  $("previewWidthHint").textContent=percentMode?`表格寬度為 ${formatPercent(value)}%；會隨後台內容區縮放。`:`實際寬度 ${value}px；寬表格可在預覽區左右捲動。`;
}

function pullStyle(){
  const tableWidthUnit=$("tableWidthUnit").value==="percent"?"percent":"px";
  styleSettings = {
    tableWidth:tableWidthUnit==="percent"?clampPercentWidth($("tableWidth").value):clampWidth($("tableWidth").value),
    tableWidthUnit,
    headerBg:$("headerBg").value,
    headerText:$("headerText").value,
    bodyBg:$("bodyBg").value,
    bodyText:$("bodyText").value,
    borderColor:$("borderColor").value,
    fontSize:Number($("fontSize").value)||14,
    textAlign:$("textAlign").value,
    cellPadding:Number($("cellPadding").value)||0
  };
}

function applyStyleInputs(){
  const tableWidthUnit=styleSettings.tableWidthUnit==="percent"?"percent":"px";
  $("tableWidthUnit").value=tableWidthUnit;
  $("tableWidth").value=tableWidthUnit==="percent"?clampPercentWidth(styleSettings.tableWidth):clampWidth(styleSettings.tableWidth);
  $("headerBg").value = styleSettings.headerBg || DEFAULT_STYLE.headerBg;
  $("headerText").value = styleSettings.headerText || DEFAULT_STYLE.headerText;
  $("bodyBg").value = styleSettings.bodyBg || DEFAULT_STYLE.bodyBg;
  $("bodyText").value = styleSettings.bodyText || DEFAULT_STYLE.bodyText;
  $("borderColor").value = styleSettings.borderColor || DEFAULT_STYLE.borderColor;
  $("fontSize").value = styleSettings.fontSize || 14;
  $("textAlign").value = styleSettings.textAlign || "center";
  $("cellPadding").value = styleSettings.cellPadding ?? 4;
  updateTableWidthUi();
}

function loadState(){
  let state=null;
  try{
    const saved=localStorage.getItem(STORAGE_KEY);
    state=saved?JSON.parse(saved):null;
  }catch(err){
    storageAvailable=false;
    setStatus("無法讀取瀏覽器保存內容，已載入空白表格。",true);
  }
  if (state?.rows?.length){
    rows = state.rows;
    merges = state.merges || [];
    columnWidths = state.columnWidths?.length ? state.columnWidths : autoColumnWidths(rows);
    styleSettings = {...DEFAULT_STYLE,...(state.styleSettings||{})};
    $("firstHeader").checked = state.firstHeader !== false;
  }
  ensureShape(); applyStyleInputs(); renderGrid(); renderPreview(); saveState();
}

function setStatus(msg,error=false){
  $("status").textContent = msg;
  $("status").style.color = error ? "#d92d20" : "#667085";
}

function extractCellTextPreserveBreaks(cell){
  let out = "";
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE){ out += node.nodeValue || ""; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === "BR"){ out += "\n"; return; }
    const block = /^(DIV|P|LI|H[1-6]|TR)$/.test(tag);
    const before = out.length;
    [...node.childNodes].forEach(walk);
    if (block && out.length > before && !out.endsWith("\n")) out += "\n";
  };
  [...cell.childNodes].forEach(walk);
  return out.replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n[ \t]+/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

function parseHtmlTableDetailed(html){
  try{
    const doc = new DOMParser().parseFromString(html,"text/html");
    const table = doc.querySelector("table");
    if (!table) return {matrix:[],merges:[]};
    const matrix = [], occupied = new Set(), foundMerges = [];
    [...table.querySelectorAll("tr")].forEach((tr,ri) => {
      if (!matrix[ri]) matrix[ri]=[];
      let ci=0;
      [...tr.querySelectorAll(":scope > th, :scope > td")].forEach(td => {
        while (occupied.has(`${ri}:${ci}`)) ci++;
        const rowspan = Math.max(1,Number(td.getAttribute("rowspan"))||1);
        const colspan = Math.max(1,Number(td.getAttribute("colspan"))||1);
        matrix[ri][ci] = extractCellTextPreserveBreaks(td);
        if (rowspan>1 || colspan>1) foundMerges.push({r:ri,c:ci,rowspan,colspan});
        for (let rr=ri; rr<ri+rowspan; rr++){
          if (!matrix[rr]) matrix[rr]=[];
          for (let cc=ci; cc<ci+colspan; cc++){
            occupied.add(`${rr}:${cc}`);
            if (!(rr===ri && cc===ci) && matrix[rr][cc] == null) matrix[rr][cc]="";
          }
        }
        ci += colspan;
      });
    });
    const width = Math.max(0,...matrix.map(r=>r.length));
    const normalized = matrix.map(r => Array.from({length:width},(_,i)=>r[i]??""));
    while (normalized.length && normalized.at(-1).every(v=>!v)) normalized.pop();
    return {matrix:normalized,merges:foundMerges};
  }catch(e){ return {matrix:[],merges:[]}; }
}

function parseCsv(text){
  const result=[]; let row=[], cur="", quoted=false;
  for (let i=0;i<text.length;i++){
    const ch=text[i];
    if (ch==='"'){
      if (quoted && text[i+1]==='"'){ cur+='"'; i++; }
      else quoted=!quoted;
    } else if (ch==="," && !quoted){ row.push(cur); cur=""; }
    else if ((ch==="\n" || ch==="\r") && !quoted){
      if (ch==="\r" && text[i+1]==="\n") i++;
      row.push(cur); result.push(row); row=[]; cur="";
    } else cur += ch;
  }
  row.push(cur); if (row.some(v=>v!=="") || result.length===0) result.push(row);
  return result;
}

function parseTextMatrix(text){
  const src=String(text||"").trim();
  if (!src) return [];
  let matrix;
  if (src.includes("\t")) matrix=src.split(/\r?\n/).map(line=>line.split("\t"));
  else if (src.includes(",")) matrix=parseCsv(src);
  else matrix=src.split(/\r?\n/).map(line=>[line]);
  const width=Math.max(0,...matrix.map(r=>r.length));
  return matrix.map(r=>Array.from({length:width},(_,i)=>String(r[i]??"").trimEnd()));
}

function applyMatrix(matrix,source="貼上資料",sourceMerges=[]){
  if (!matrix?.length) return setStatus("沒有偵測到可用表格。",true);
  const maxRows=100,maxCols=30;
  const clipped=matrix.slice(0,maxRows).map(r=>r.slice(0,maxCols));
  const width=Math.max(1,...clipped.map(r=>r.length));
  rows=clipped.map(r=>Array.from({length:width},(_,i)=>String(r[i]??"")));
  columnWidths=autoColumnWidths(rows);
  merges=(sourceMerges||[]).filter(m=>m.r<rows.length&&m.c<width&&m.r+m.rowspan<=rows.length&&m.c+m.colspan<=width);
  selection=null;
  renderGrid();renderPreview();saveState();
  const mergeNote=merges.length?`，保留 ${merges.length} 個合併區塊`:"";
  setStatus(`${source}：${rows.length} 列 × ${width} 欄${mergeNote}`);
}

function matrixToTsv(matrix){
  return matrix.map(r=>r.map(v=>String(v??"").replace(/\r?\n/g," ↵ ")).join("\t")).join("\n");
}

function updatePasteInfo(matrix,mergeCount=0){
  if (!matrix?.length){ $("pasteInfo").textContent="尚未偵測到表格資料"; return; }
  const width=Math.max(0,...matrix.map(r=>r.length));
  $("pasteInfo").textContent=`已偵測 ${matrix.length} 列 × ${width} 欄${mergeCount?`，${mergeCount} 個合併區塊`:""}`;
}

function fallbackCopy(html,text){
  const holder=document.createElement("div");
  holder.contentEditable="true";
  holder.setAttribute("aria-hidden","true");
  holder.style.cssText="position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none";
  holder.innerHTML=html;
  document.body.appendChild(holder);
  const range=document.createRange();
  range.selectNodeContents(holder);
  const selectionApi=window.getSelection();
  selectionApi.removeAllRanges();
  selectionApi.addRange(range);
  let copied=false;
  try{ copied=document.execCommand("copy"); }catch(err){ copied=false; }
  selectionApi.removeAllRanges();
  holder.remove();
  if (!copied && navigator.clipboard?.writeText){
    return navigator.clipboard.writeText(text).then(()=>"plain");
  }
  return copied?Promise.resolve("rich"):Promise.reject(new Error("copy failed"));
}

async function copyRich(){
  const html=buildHtml();
  const text=plainText();
  const bytes=updateByteMeter(html);
  try{
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("rich clipboard unavailable");
    const item=new ClipboardItem({
      "text/html":new Blob([html],{type:"text/html"}),
      "text/plain":new Blob([text],{type:"text/plain"})
    });
    await navigator.clipboard.write([item]);
    if (bytes>LIMIT_BYTES) setStatus(`已複製，但目前估算 ${bytes.toLocaleString()} Byte，超過後台上限。`,true);
    else if (bytes>SAFE_BYTES) setStatus(`已複製；目前 ${bytes.toLocaleString()} Byte，接近上限，貼入後請確認 Byte 顯示。`);
    else setStatus(`已複製表格（${bytes.toLocaleString()} Byte）→ 回後台 Ctrl+V`);
  }catch(err){
    try{
      const mode=await fallbackCopy(html,text);
      if (mode==="plain") setStatus("瀏覽器只允許複製純文字；請改用 HTTPS 開啟以複製表格格式。",true);
      else if (bytes>LIMIT_BYTES) setStatus(`已用相容模式複製，但 ${bytes.toLocaleString()} Byte 超過後台上限。`,true);
      else setStatus(`已用相容模式複製表格（${bytes.toLocaleString()} Byte）→ 回後台 Ctrl+V`);
    }catch(fallbackError){
      setStatus("無法存取剪貼簿；請允許網站使用剪貼簿，並確認使用 HTTPS 或 localhost 開啟。",true);
    }
  }
}

$("bulkPaste").addEventListener("paste",e=>{
  const html=e.clipboardData?.getData("text/html")||"";
  const detailed=html?parseHtmlTableDetailed(html):{matrix:[],merges:[]};
  if (detailed.matrix.length){
    e.preventDefault();
    pendingMatrix=detailed.matrix;
    pendingMerges=detailed.merges||[];
    $("bulkPaste").value=matrixToTsv(detailed.matrix);
    updatePasteInfo(detailed.matrix,pendingMerges.length);
    applyMatrix(detailed.matrix,"已直接套用試算表",pendingMerges);
  }else{
    pendingMatrix=null;pendingMerges=[];
    setTimeout(()=>{
      const m=parseTextMatrix($("bulkPaste").value);
      updatePasteInfo(m,0);
      if (m.length) applyMatrix(m,"已直接套用貼上資料",[]);
    },0);
  }
});
$("bulkPaste").addEventListener("input",()=>{ pendingMatrix=null;pendingMerges=[];updatePasteInfo(parseTextMatrix($("bulkPaste").value),0); });
$("applyPaste").addEventListener("click",()=>applyMatrix(pendingMatrix?.length?pendingMatrix:parseTextMatrix($("bulkPaste").value),"貼上資料",pendingMerges));

$("createBlank").addEventListener("click",()=>{
  const r=Math.max(1,Math.min(100,Number($("blankRows").value)||1));
  const c=Math.max(1,Math.min(30,Number($("blankCols").value)||1));
  rows=blankMatrix(r,c);columnWidths=Array(c).fill(DEFAULT_COLUMN_WIDTH);merges=[];selection=null;renderGrid();renderPreview();saveState();setStatus(`已建立 ${r} 列 × ${c} 欄空白表格`);
});

$("addRowAbove").addEventListener("click",()=>{
  if(rows.length>=100) return setStatus("最多 100 列。",true);
  const s=selectedOrLast(); insertRows(s.r1,1); afterStructureChange("已在上方新增 1 列",{r:s.r1,c:s.c1});
});
$("addRowBelow").addEventListener("click",()=>{
  if(rows.length>=100) return setStatus("最多 100 列。",true);
  const s=selectedOrLast(); const at=s.r2+1; insertRows(at,1); afterStructureChange("已在下方新增 1 列",{r:at,c:s.c1});
});
$("delRow").addEventListener("click",()=>{
  const s=selectedOrLast(); const count=s.r2-s.r1+1; if(count>=rows.length)return setStatus("至少保留 1 列。",true); deleteRows(s.r1,s.r2); afterStructureChange(`已刪除 ${count} 列`,{r:Math.min(s.r1,rows.length-1),c:Math.min(s.c1,rows[0].length-1)});
});
$("addColLeft").addEventListener("click",()=>{
  if(rows[0].length>=30) return setStatus("最多 30 欄。",true);
  const s=selectedOrLast(); insertCols(s.c1,1); afterStructureChange("已在左側新增 1 欄",{r:s.r1,c:s.c1});
});
$("addColRight").addEventListener("click",()=>{
  if(rows[0].length>=30) return setStatus("最多 30 欄。",true);
  const s=selectedOrLast(); const at=s.c2+1; insertCols(at,1); afterStructureChange("已在右側新增 1 欄",{r:s.r1,c:at});
});
$("delCol").addEventListener("click",()=>{
  const s=selectedOrLast(); const count=s.c2-s.c1+1; if(count>=rows[0].length)return setStatus("至少保留 1 欄。",true); deleteCols(s.c1,s.c2); afterStructureChange(`已刪除 ${count} 欄`,{r:Math.min(s.r1,rows.length-1),c:Math.min(s.c1,rows[0].length-1)});
});
$("merge").addEventListener("click",mergeSelection);
$("unmerge").addEventListener("click",unmergeSelection);
$("clearTable").addEventListener("click",()=>{rows=blankMatrix(4,4);columnWidths=Array(4).fill(DEFAULT_COLUMN_WIDTH);merges=[];selection=null;$("bulkPaste").value="";updatePasteInfo([]);renderGrid();renderPreview();saveState();setStatus("已清空並建立 4 × 4 空白表格");});

$("selectedColWidth").addEventListener("input",event=>{
  const percent=Number(event.target.value);
  if (percent>=Number(event.target.min)&&percent<=Number(event.target.max)) applyPercentageToSelected(percent);
});
$("selectedColWidth").addEventListener("change",event=>{
  if (event.target.value!=="") applyPercentageToSelected(event.target.value);
});
$("colWidthDecrease").addEventListener("click",()=>stepSelectedPercentages(-1));
$("colWidthIncrease").addEventListener("click",()=>stepSelectedPercentages(1));
$("fitSelectedCols").addEventListener("click",fitSelectedColumns);
$("equalizeCols").addEventListener("click",equalizeColumns);

$("firstHeader").addEventListener("change",()=>{renderPreview();saveState();});
["tableWidth","headerBg","headerText","bodyBg","bodyText","borderColor","fontSize","textAlign","cellPadding"].forEach(id=>$(id).addEventListener("input",()=>{pullStyle();updateTableWidthUi();renderPreview();saveState();}));
$("tableWidthUnit").addEventListener("change",()=>{
  const percentMode=$("tableWidthUnit").value==="percent";
  $("tableWidth").value=percentMode?"100":"1000";
  pullStyle();updateTableWidthUi();renderPreview();saveState();
  setStatus(`表格總寬度已切換為 ${percentMode?"百分比":"像素"}模式`);
});
document.querySelectorAll(".width-preset").forEach(btn=>btn.addEventListener("click",()=>{
  const unit=btn.dataset.unit==="percent"?"percent":"px";
  $("tableWidthUnit").value=unit;
  $("tableWidth").value=btn.dataset.width;
  pullStyle();updateTableWidthUi();renderPreview();saveState();
  setStatus(`表格寬度已設為 ${btn.dataset.width}${unit==="percent"?"%":"px"}`);
}));
$("copyRich").addEventListener("click",copyRich);

loadState();

