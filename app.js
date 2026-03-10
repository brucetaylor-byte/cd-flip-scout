const inventoryKey = 'cdFlipScoutInventory';
const tokenKey = 'cdFlipScoutDiscogsToken';
const fxKey = 'cdFlipScoutFxRate';

let currentStream = null;
let scanLoopHandle = null;
let currentCandidates = [];
let selectedAnalysis = null;
let candidateCollapsed = false;
let lookupCollapsed = false;
let deferredInstallPrompt = null;


/* ---------- BASIC HELPERS ---------- */

function getEl(id){
  return document.getElementById(id);
}

function money(v){
  if(!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-AU',{
    style:'currency',
    currency:'AUD'
  }).format(v);
}

function escapeHtml(value){
  return String(value ?? '')
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;')
  .replace(/'/g,'&#39;');
}

function getNumber(id){
  const el = getEl(id);
  if(!el) return 0;
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : 0;
}


/* ---------- SETTINGS ---------- */

function toggleSettings(){
  const panel = getEl('settingsPanel');
  const button = getEl('settingsToggle');

  const open = panel.classList.contains('open');

  panel.classList.toggle('open',!open);

  button.innerText = open ? "▼ Settings":"▲ Settings";
  button.setAttribute("aria-expanded",!open);
}

function toggleLookupPanel(force=null){

  const panel = getEl("lookupPanel");
  const button = getEl("lookupToggle");

  const open = force==null ? lookupCollapsed : !force;

  lookupCollapsed = !open;

  panel.style.display = open ? "block":"none";

  button.innerText = open ? "▲ Lookup":"▼ Lookup";

}


/* ---------- PREFS ---------- */

function savePrefs(){

  localStorage.setItem(tokenKey,getEl("token").value.trim());
  localStorage.setItem(fxKey,getEl("fxRate").value.trim());

}

function loadPrefs(){

  const t = localStorage.getItem(tokenKey);
  const f = localStorage.getItem(fxKey);

  if(t) getEl("token").value = t;
  if(f) getEl("fxRate").value = f;

}


/* ---------- STATUS ---------- */

function setStatus(msg){
  const el = getEl("lookupStatus");
  if(el) el.textContent = msg;
}


/* ---------- DISCOGS ---------- */

function buildHeaders(){

  const h = {
    Accept:"application/vnd.discogs.v2.discogs+json"
  };

  const token = getEl("token").value.trim();

  if(token){
    h["Authorization"] = `Discogs token=${token}`;
  }

  return h;
}

function toAud(amount,currency){

  if(!Number.isFinite(amount)) return 0;

  const fx = getNumber("fxRate") || 1;

  if(currency==="AUD") return amount;

  return amount * fx;

}


/* ---------- PRICE ---------- */

function roundSellPrice(v){
  if(!Number.isFinite(v) || v<=0) return 0;
  return Math.round(v*2)/2;
}

function suggestSellPrice(reference,lowest,demand){

  if(!reference) return 0;

  if(demand==="High"){
    return roundSellPrice(Math.max(reference,lowest||0));
  }

  if(demand==="Medium"){

    if(lowest){
      return roundSellPrice(Math.min(reference,lowest+1));
    }

    return roundSellPrice(reference);
  }

  if(lowest){
    return roundSellPrice(Math.max(lowest-0.5,0));
  }

  return roundSellPrice(reference);
}

function buildListingStrategy(reference,lowest,demand){

  if(!reference) return {quickSale:0,balanced:0,maxProfit:0};

  const quickSale = suggestSellPrice(reference,lowest,"Low");
  const balanced = suggestSellPrice(reference,lowest,demand);
  const maxProfit = roundSellPrice(Math.max(reference,balanced));

  return {quickSale,balanced,maxProfit};
}


/* ---------- PROFIT ---------- */

function calculateProfitFromSellPrice(sell){

  const buy = getNumber("buyPrice");
  const discogs = getNumber("discogsFee")/100;
  const paypalPct = getNumber("paypalPct")/100;
  const paypalFixed = getNumber("paypalFixed");

  const discogsCost = sell * discogs;
  const paypalCost = sell * paypalPct + paypalFixed;

  const profit = sell - discogsCost - paypalCost - buy;

  return {discogsCost,paypalCost,profit};
}


/* ---------- DEMAND ---------- */

function calcDemand(stats,release){

  const forSale = Number(stats?.num_for_sale || 0);
  const want = Number(release?.community?.want || 0);

  const ratio = forSale>0 ? want/forSale : want;

  if(want>=50 && ratio>=2) return {label:"High",ratio};

  if(want>=10 && ratio>=0.7) return {label:"Medium",ratio};

  return {label:"Low",ratio};
}


/* ---------- RECOMMENDATION ---------- */

function scoreRecommendation(profit,demand,discogs,format){

  let level="Skip";
  let cls="skip";

  if(profit>=10){
    level="Strong Buy"; cls="strong-buy";
  } else if(profit>=6){
    level="Buy"; cls="buy";
  } else if(profit>=3){
    level="Maybe"; cls="maybe";
  }

  if(demand==="Low" && level==="Strong Buy") level="Buy";
  if(demand==="Low" && level==="Buy") level="Maybe";

  return {label:level,cls};

}


/* ---------- INVENTORY ---------- */

function loadInventory(){

  try{
    return JSON.parse(localStorage.getItem(inventoryKey) || "[]");
  }catch{
    return [];
  }

}

function saveInventory(items){
  localStorage.setItem(inventoryKey,JSON.stringify(items));
}

function saveItem(){

  if(!selectedAnalysis) return;

  const items = loadInventory();

  items.unshift(selectedAnalysis);

  saveInventory(items);

  renderInventory();

}

function removeInventoryItem(i){

  const items = loadInventory();

  items.splice(i,1);

  saveInventory(items);

  renderInventory();

}

function renderInventory(){

  const items = loadInventory();

  const area = getEl("inventoryArea");

  if(!items.length){
    area.innerHTML="No saved items yet.";
    return;
  }

  area.innerHTML = items.slice(0,3).map(x=>`
    ${escapeHtml(x.title)} — ${money(x.profit)}
  `).join("<br>");

}


/* ---------- CAMERA SCAN ---------- */

async function startBarcodeScan(){

  if(!navigator.mediaDevices){
    setStatus("Camera not supported");
    return;
  }

  toggleLookupPanel(false);

  try{

    stopBarcodeScan();

    const video = getEl("preview");

    currentStream = await navigator.mediaDevices.getUserMedia({
      video:{facingMode:"environment"}
    });

    video.srcObject = currentStream;

    video.style.display="block";

    await video.play();

    video.scrollIntoView({behavior:"smooth"});

    const detector = new BarcodeDetector({
      formats:["ean_13","upc_a"]
    });

    const scan = async()=>{

      const codes = await detector.detect(video);

      if(codes.length){

        const code = codes[0].rawValue;

        getEl("barcode").value = code;

        stopBarcodeScan();

        lookupDiscogs();

        return;

      }

      scanLoopHandle = requestAnimationFrame(scan);
    };

    scanLoopHandle = requestAnimationFrame(scan);

  }
  catch(err){

    setStatus("Camera access failed: "+err.message);

  }

}

function stopBarcodeScan(){

  if(scanLoopHandle){
    cancelAnimationFrame(scanLoopHandle);
    scanLoopHandle=null;
  }

  if(currentStream){

    currentStream.getTracks().forEach(t=>t.stop());

    currentStream=null;

  }

  const video = getEl("preview");

  video.pause();
  video.srcObject=null;
  video.style.display="none";

}


/* ---------- INIT ---------- */

document.addEventListener("input",(e)=>{

  if([
    "buyPrice",
    "discogsFee",
    "paypalPct",
    "paypalFixed"
  ].includes(e.target.id)){

    if(selectedAnalysis) renderRecommendation(selectedAnalysis);

  }

});


window.addEventListener("beforeinstallprompt",(e)=>{

  e.preventDefault();

  deferredInstallPrompt = e;

  getEl("installBtn").style.display="inline-block";

});


window.addEventListener("load",()=>{

  loadPrefs();

  toggleLookupPanel(true);

  renderInventory();

});
