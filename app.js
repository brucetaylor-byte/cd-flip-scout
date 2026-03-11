const inventoryKey = 'cdFlipScoutInventory';
const tokenKey = 'cdFlipScoutDiscogsToken';
const fxKey = 'cdFlipScoutFxRate';
const opShopKey = 'cdFlipScoutOpShops';

const INVENTORY_STATUSES = ['To clean', 'To list', 'Listed', 'Sold', 'Hold'];

let currentStream = null;
let scanLoopHandle = null;
let currentCandidates = [];
let selectedAnalysis = null;
let candidateCollapsed = false;
let lookupCollapsed = false;
let deferredInstallPrompt = null;
let editingOpShopId = null;

function getEl(id) {
  return document.getElementById(id);
}

function toggleSettings() {
  const panel = getEl('settingsPanel');
  const button = getEl('settingsToggle');
  if (!panel || !button) return;
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  button.innerText = isOpen ? '▼ Settings' : '▲ Settings';
  button.setAttribute('aria-expanded', String(!isOpen));
}

function toggleLookupPanel(forceState = null) {
  const panel = getEl('lookupPanel');
  const button = getEl('lookupToggle');
  if (!panel || !button) return;
  const nextOpen = forceState == null ? lookupCollapsed : !forceState;
  lookupCollapsed = !nextOpen;
  panel.style.display = nextOpen ? 'block' : 'none';
  button.innerText = nextOpen ? '▲ Lookup' : '▼ Lookup';
  button.setAttribute('aria-expanded', String(nextOpen));
}

function triggerInstall() {
  if (!deferredInstallPrompt) {
    const status = getEl('installStatus');
    if (status) status.textContent = 'Install is not available yet on this device/browser session.';
    return;
  }

  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => {
    deferredInstallPrompt = null;
    const btn = getEl('installBtn');
    const status = getEl('installStatus');
    if (btn) btn.style.display = 'none';
    if (status) status.textContent = 'Install prompt shown.';
  });
}

function openDiscogsUrl(url) {
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function showCandidateInDiscogs(index) {
  const item = currentCandidates[index];
  if (!item || !item.id) return;
  openDiscogsUrl(`https://www.discogs.com/release/${item.id}`);
}

function money(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNumber(id) {
  const el = getEl(id);
  if (!el) return 0;
  const parsed = parseFloat(el.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normaliseNumber(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function savePrefs() {
  const tokenEl = getEl('token');
  const fxEl = getEl('fxRate');
  if (tokenEl) localStorage.setItem(tokenKey, tokenEl.value.trim());
  if (fxEl) localStorage.setItem(fxKey, fxEl.value.trim());
}

function loadPrefs() {
  const tokenEl = getEl('token');
  const fxEl = getEl('fxRate');
  if (tokenEl) tokenEl.value = localStorage.getItem(tokenKey) || '';
  if (fxEl) fxEl.value = localStorage.getItem(fxKey) || '1.55';
}

function setStatus(message) {
  const el = getEl('lookupStatus');
  if (el) el.textContent = message;
}

function buildHeaders() {
  const headers = { Accept: 'application/vnd.discogs.v2.discogs+json' };
  const token = getEl('token')?.value.trim();
  if (token) headers.Authorization = `Discogs token=${token}`;
  return headers;
}

function toAud(amount, currency) {
  if (!Number.isFinite(amount)) return 0;
  const fxRate = getNumber('fxRate') || 1;
  const code = String(currency || 'AUD').toUpperCase();
  return code === 'AUD' ? amount : amount * fxRate;
}

function roundSellPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 2) / 2;
}

function suggestSellPrice(referenceAud, lowestAud, demandLabel) {
  if (!Number.isFinite(referenceAud) || referenceAud <= 0) return 0;
  if (demandLabel === 'High') return roundSellPrice(Math.max(referenceAud, lowestAud || 0));
  if (demandLabel === 'Medium') {
    if (Number.isFinite(lowestAud) && lowestAud > 0) return roundSellPrice(Math.min(referenceAud, lowestAud + 1));
    return roundSellPrice(referenceAud);
  }
  if (Number.isFinite(lowestAud) && lowestAud > 0) return roundSellPrice(Math.max(lowestAud - 0.5, 0));
  return roundSellPrice(referenceAud);
}

function buildListingStrategy(referenceAud, lowestAud, demandLabel) {
  if (!Number.isFinite(referenceAud) || referenceAud <= 0) {
    return { quickSale: 0, balanced: 0, maxProfit: 0 };
  }
  const quickSale = suggestSellPrice(referenceAud, lowestAud, 'Low');
  const balanced = suggestSellPrice(referenceAud, lowestAud, demandLabel);
  const maxProfit = roundSellPrice(Math.max(referenceAud, balanced));
  return { quickSale, balanced, maxProfit };
}

function getBlendedReferencePrice(discogsReferenceAud) {
  const ebayMedian = getNumber('ebayMedian');
  const mode = getEl('priceBlendMode')?.value || 'discogs';
  const hasDiscogs = Number.isFinite(discogsReferenceAud) && discogsReferenceAud > 0;
  const hasEbay = Number.isFinite(ebayMedian) && ebayMedian > 0;

  if (mode === 'ebay') return hasEbay ? ebayMedian : 0;
  if (mode === 'avg') {
    if (hasDiscogs && hasEbay) return roundSellPrice((discogsReferenceAud + ebayMedian) / 2);
    return hasDiscogs ? discogsReferenceAud : (hasEbay ? ebayMedian : 0);
  }
  if (mode === 'max') {
    if (hasDiscogs && hasEbay) return Math.max(discogsReferenceAud, ebayMedian);
    return hasDiscogs ? discogsReferenceAud : (hasEbay ? ebayMedian : 0);
  }
  return hasDiscogs ? discogsReferenceAud : 0;
}

function getPriceBasisLabel(discogsBasis, blendedReferenceAud) {
  const ebayMedian = getNumber('ebayMedian');
  const mode = getEl('priceBlendMode')?.value || 'discogs';
  const hasEbay = Number.isFinite(ebayMedian) && ebayMedian > 0;
  if (!hasEbay || mode === 'discogs') return discogsBasis;
  if (mode === 'ebay') return 'eBay AU sold median';
  if (mode === 'avg') return 'Blended average: Discogs + eBay AU';
  if (mode === 'max') return blendedReferenceAud === ebayMedian ? 'eBay AU stronger than Discogs' : 'Discogs stronger than eBay AU';
  return discogsBasis;
}

function calculateProfitFromSellPrice(sellPrice) {
  const buyPrice = getNumber('buyPrice');
  const discogsFee = getNumber('discogsFee') / 100;
  const paypalPct = getNumber('paypalPct') / 100;
  const paypalFixed = getNumber('paypalFixed');
  const discogsCost = sellPrice * discogsFee;
  const paypalCost = sellPrice * paypalPct + paypalFixed;
  const profit = sellPrice - discogsCost - paypalCost - buyPrice;
  return { discogsCost, paypalCost, profit };
}

async function fetchDiscogsJson(url) {
  try {
    const response = await fetch(url, { headers: buildHeaders(), mode: 'cors' });
    if (!response.ok) throw new Error(`Discogs returned ${response.status}`);
    return await response.json();
  } catch (error) {
    return await fetchDiscogsJsonp(url);
  }
}

function fetchDiscogsJsonp(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `discogsCallback_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const script = document.createElement('script');
    const separator = url.includes('?') ? '&' : '?';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Discogs JSONP request timed out'));
    }, 12000);

    function cleanup() {
      clearTimeout(timeout);
      if (script.parentNode) script.parentNode.removeChild(script);
      delete window[callbackName];
    }

    window[callbackName] = (payload) => {
      cleanup();
      if (payload && payload.meta && payload.meta.status && payload.meta.status >= 400) {
        reject(new Error(`Discogs JSONP returned ${payload.meta.status}`));
        return;
      }
      resolve(payload && payload.data ? payload.data : payload);
    };

    script.src = `${url}${separator}callback=${callbackName}`;
    script.onerror = () => {
      cleanup();
      reject(new Error('Discogs JSONP failed'));
    };
    document.body.appendChild(script);
  });
}

function buildSearchUrl() {
  const barcode = getEl('barcode')?.value.trim() || '';
  const catno = getEl('catno')?.value.trim() || '';
  const artist = getEl('artist')?.value.trim() || '';
  const album = getEl('album')?.value.trim() || '';
  const formatFilter = getEl('formatFilter')?.value.trim() || '';
  const params = new URLSearchParams();
  params.set('type', 'release');
  params.set('per_page', '10');
  if (barcode) params.set('barcode', barcode);
  if (catno) params.set('catno', catno);
  if (artist) params.set('artist', artist);
  if (album) params.set('release_title', album);
  if (formatFilter) params.set('format', formatFilter);
  return `https://api.discogs.com/database/search?${params.toString()}`;
}

async function lookupDiscogs() {
  savePrefs();
  const barcode = getEl('barcode')?.value.trim() || '';
  const catno = getEl('catno')?.value.trim() || '';
  const artist = getEl('artist')?.value.trim() || '';
  const album = getEl('album')?.value.trim() || '';
  if (!barcode && !catno && !artist && !album) {
    setStatus('Enter a barcode, catalog number, or at least artist and album.');
    return;
  }
  setStatus('Looking up Discogs…');
  getEl('candidateArea').innerHTML = '<div class="empty">Searching…</div>';
  getEl('recommendationArea').innerHTML = '<div class="empty">Select a Discogs release to analyse it.</div>';
  selectedAnalysis = null;
  candidateCollapsed = false;
  try {
    const data = await fetchDiscogsJson(buildSearchUrl());
    const results = Array.isArray(data.results) ? data.results : [];
    currentCandidates = results;
    renderCandidates(results);
    setStatus(results.length ? `Found ${results.length} Discogs candidate${results.length === 1 ? '' : 's'}.` : 'No Discogs results found.');
  } catch (error) {
    setStatus(`Lookup failed: ${error.message}`);
    getEl('candidateArea').innerHTML = '<div class="empty">Lookup failed. Try a token, catalog number, or artist + album fallback.</div>';
  }
}

function renderCandidates(results) {
  const area = getEl('candidateArea');
  if (!area) return;

  if (!results.length) {
    area.innerHTML = '<div class="empty">No Discogs results yet.</div>';
    return;
  }
  if (candidateCollapsed && selectedAnalysis) {
    area.innerHTML = `
      <div class="candidate">
        <div class="candidate-title">Selected release: ${escapeHtml(selectedAnalysis.title)}</div>
        <div class="candidate-meta">Candidate list collapsed to save scrolling.</div>
        <div class="row">
          <button type="button" class="secondary" onclick="expandCandidates()">Show candidate list again</button>
          <button type="button" class="secondary" onclick="openDiscogsUrl(selectedAnalysis.discogsUrl)">Show in Discogs</button>
        </div>
      </div>
    `;
    return;
  }

  area.innerHTML = results.map((item, index) => {
    const formats = Array.isArray(item.format) ? item.format.join(', ') : (item.format || 'Unknown format');
    const catno = item.catno || 'No cat#';
    const title = item.title || 'Untitled release';
    const meta = [item.year || 'Year unknown', item.country || 'Country unknown', formats, catno].join(' • ');
    return `
      <div class="candidate">
        <div class="candidate-title">${escapeHtml(title)}</div>
        <div class="candidate-meta">${escapeHtml(meta)}</div>
        <div class="row">
          <button type="button" onclick="selectCandidate(${index})">Use this release</button>
          <button type="button" class="secondary" onclick="showCandidateInDiscogs(${index})">Show in Discogs</button>
          <span class="small">Discogs ID: ${escapeHtml(item.id || '—')}</span>
        </div>
      </div>
    `;
  }).join('');
}

function expandCandidates() {
  candidateCollapsed = false;
  renderCandidates(currentCandidates);
}

function getFormatCategory(release, fallbackItem = null) {
  const releaseFormats = Array.isArray(release?.formats) ? release.formats.map((f) => f.name || '').filter(Boolean) : [];
  const itemFormats = Array.isArray(fallbackItem?.format) ? fallbackItem.format : (fallbackItem?.format ? [fallbackItem.format] : []);
  const all = [...releaseFormats, ...itemFormats].map((x) => String(x).toLowerCase());
  if (all.some((x) => x.includes('vinyl') || x.includes('lp'))) return 'Vinyl';
  if (all.some((x) => x.includes('dvd') || x.includes('blu-ray') || x.includes('bluray'))) return 'DVD';
  if (all.some((x) => x.includes('cd'))) return 'CD';
  return 'Other';
}

function calcDemand(stats, release) {
  const forSale = Number(stats?.num_for_sale || 0);
  const want = Number(release?.community?.want || 0);
  const ratio = forSale > 0 ? want / forSale : (want > 0 ? want : 0);
  if (want >= 50 && ratio >= 2) return { label: 'High', ratio };
  if (want >= 10 && ratio >= 0.7) return { label: 'Medium', ratio };
  return { label: 'Low', ratio };
}

function getFormatThresholds(formatCategory) {
  if (formatCategory === 'Vinyl') return { maybe: 5, buy: 10, strong: 18 };
  if (formatCategory === 'DVD') return { maybe: 3, buy: 8, strong: 14 };
  return { maybe: 3, buy: 6, strong: 10 };
}

function scoreRecommendation(profit, demandLabel, inDiscogs, formatCategory) {
  let level = 'Skip';
  let cls = 'skip';
  const thresholds = getFormatThresholds(formatCategory);
  if (profit >= thresholds.strong) {
    level = 'Strong Buy';
    cls = 'strong-buy';
  } else if (profit >= thresholds.buy) {
    level = 'Buy';
    cls = 'buy';
  } else if (profit >= thresholds.maybe) {
    level = 'Maybe';
    cls = 'maybe';
  }
  if (demandLabel === 'Low' && level === 'Strong Buy') {
    level = 'Buy';
    cls = 'buy';
  } else if (demandLabel === 'Low' && level === 'Buy') {
    level = 'Maybe';
    cls = 'maybe';
  }
  if (!inDiscogs && level === 'Strong Buy') {
    level = 'Buy';
    cls = 'buy';
  } else if (!inDiscogs && level === 'Buy') {
    level = 'Maybe';
    cls = 'maybe';
  } else if (!inDiscogs && level === 'Maybe') {
    level = 'Skip';
    cls = 'skip';
  }
  return { label: level, cls };
}

async function selectCandidate(index) {
  const item = currentCandidates[index];
  if (!item || !item.id) return;
  setStatus(`Loading release ${item.id}…`);
  getEl('recommendationArea').innerHTML = '<div class="empty">Analysing release…</div>';
  try {
    const [release, stats] = await Promise.all([
      fetchDiscogsJson(`https://api.discogs.com/releases/${item.id}`),
      fetchDiscogsJson(`https://api.discogs.com/marketplace/stats/${item.id}`)
    ]);
    const medianRaw = Number(stats?.median_price?.value ?? 0);
    const lowestRaw = Number(stats?.lowest_price?.value ?? 0);
    const rawCurrency = stats?.median_price?.currency || stats?.lowest_price?.currency || 'AUD';
    const medianAud = toAud(medianRaw, rawCurrency);
    const lowestAud = toAud(lowestRaw, rawCurrency);
    const discogsReferenceAud = medianAud > 0 ? medianAud : lowestAud;
    const discogsBasis = medianAud > 0 ? 'Median sales history' : (lowestAud > 0 ? 'Lowest current listing' : 'No usable market data');
    const referenceAud = getBlendedReferencePrice(discogsReferenceAud);
    const priceBasis = getPriceBasisLabel(discogsBasis, referenceAud);
    const demand = calcDemand(stats, release);
    const formatCategory = getFormatCategory(release, item);
    const strategy = buildListingStrategy(referenceAud, lowestAud, demand.label);
    const suggestedMath = strategy.balanced > 0 ? calculateProfitFromSellPrice(strategy.balanced) : { discogsCost: 0, paypalCost: 0, profit: null };
    const quickMath = strategy.quickSale > 0 ? calculateProfitFromSellPrice(strategy.quickSale) : { profit: null };
    const maxMath = strategy.maxProfit > 0 ? calculateProfitFromSellPrice(strategy.maxProfit) : { profit: null };
    const rec = strategy.balanced > 0 ? scoreRecommendation(suggestedMath.profit, demand.label, true, formatCategory) : { label: 'No market data', cls: 'skip' };
    const title = [release.artists_sort || '', release.title || 'Untitled release'].filter(Boolean).join(' – ');

    selectedAnalysis = {
      discogsUrl: `https://www.discogs.com/release/${item.id}`,
      id: item.id,
      title,
      barcode: getEl('barcode')?.value.trim() || '',
      catno: (getEl('catno')?.value.trim() || item.catno || ''),
      formatCategory,
      medianAud,
      lowestAud,
      discogsReferenceAud,
      referenceAud,
      priceBasis,
      ebayMedian: getNumber('ebayMedian'),
      priceBlendMode: getEl('priceBlendMode')?.value || 'discogs',
      suggestedSellPrice: strategy.balanced,
      quickSalePrice: strategy.quickSale,
      maxProfitPrice: strategy.maxProfit,
      profit: suggestedMath.profit,
      quickProfit: quickMath.profit,
      maxProfit: maxMath.profit,
      demand: demand.label,
      demandRatio: demand.ratio,
      numForSale: Number(stats?.num_for_sale || 0),
      want: Number(release?.community?.want || 0),
      have: Number(release?.community?.have || 0),
      recommendation: rec.label,
      buyPrice: getNumber('buyPrice'),
      discogsCost: suggestedMath.discogsCost,
      paypalCost: suggestedMath.paypalCost,
      sourceCurrency: rawCurrency,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'To clean',
      quantity: 1,
      listPriceAud: strategy.balanced,
      mediaCondition: '',
      sleeveCondition: '',
      comment: ''
    };

    candidateCollapsed = true;
    renderCandidates(currentCandidates);
    renderRecommendation(selectedAnalysis, rec);
    setStatus(`Loaded Discogs release ${item.id}.`);
  } catch (error) {
    setStatus(`Release analysis failed: ${error.message}`);
    getEl('recommendationArea').innerHTML = '<div class="empty">Could not load marketplace stats for this release.</div>';
  }
}

function showDecisionFlash(label) {
  const flash = getEl('buyFlash');
  if (!flash) return;

  if (label === 'Buy' || label === 'Strong Buy') {
    flash.style.background = 'rgba(0,180,0,0.92)';
    flash.textContent = 'BUY!';
  } else if (label === 'Maybe') {
    flash.style.background = 'rgba(220,170,0,0.92)';
    flash.textContent = 'MAYBE';
  } else {
    flash.style.background = 'rgba(180,0,0,0.92)';
    flash.textContent = 'SKIP';
  }

  flash.style.display = 'flex';
  requestAnimationFrame(() => {
    flash.style.opacity = '1';
  });

  setTimeout(() => {
    flash.style.opacity = '0';
    setTimeout(() => {
      flash.style.display = 'none';
    }, 350);
  }, 1000);
}

function renderRecommendation(analysis, rec) {
  const hasMarketPrice = analysis.referenceAud > 0 && analysis.suggestedSellPrice > 0;
  const summarySentence = hasMarketPrice
    ? `${rec.label.toUpperCase()} — list at ${money(analysis.suggestedSellPrice)} for about ${analysis.profit == null ? '—' : money(analysis.profit)} profit`
    : 'No usable market price found';
  const marketMessage = hasMarketPrice
    ? `<div class="pill info">Price basis: ${escapeHtml(analysis.priceBasis)}</div>`
    : `<div class="pill skip">No usable Discogs market price found</div>`;

  getEl('recommendationArea').innerHTML = `
    <h3>${escapeHtml(analysis.title)}</h3>
    <div class="small"><a href="${escapeHtml(analysis.discogsUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--blue); text-decoration: none; font-weight: 600;">Open this release in Discogs</a></div>
    <div class="pill ${rec.cls}" style="font-size:20px; padding:12px 18px;">${escapeHtml(rec.label)}</div>
    <div style="font-size:18px; font-weight:700; margin-top:10px;">${escapeHtml(summarySentence)}</div>
    <div class="stat"><span class="muted">Estimated profit</span><strong>${analysis.profit == null ? '—' : money(analysis.profit)}</strong></div>
    <div class="stat"><span class="muted">Suggested list price</span><strong>${money(analysis.suggestedSellPrice)}</strong></div>
    <div class="stat"><span class="muted">Demand</span><strong>${escapeHtml(analysis.demand)}</strong></div>
    ${marketMessage}
    <div class="row" style="margin-top:14px;">
      <button type="button" onclick="saveItem()">Add to Inventory</button>
      <button type="button" class="secondary" onclick="openDiscogsUrl(selectedAnalysis.discogsUrl)">Open in Discogs</button>
      <button type="button" class="secondary" onclick="toggleDetails()">More details</button>
    </div>
    <div id="detailsPanel" style="display:none; margin-top:14px;">
      <div class="stat"><span class="muted">Barcode</span><strong>${escapeHtml(analysis.barcode || 'Not scanned')}</strong></div>
      <div class="stat"><span class="muted">Catalog number</span><strong>${escapeHtml(analysis.catno || '—')}</strong></div>
      <div class="stat"><span class="muted">Format</span><strong>${escapeHtml(analysis.formatCategory || 'Other')}</strong></div>
      <div class="stat"><span class="muted">Discogs release ID</span><strong>${escapeHtml(analysis.id)}</strong></div>
      <div class="stat"><span class="muted">Status on save</span><strong>${escapeHtml(analysis.status || 'To clean')}</strong></div>
      <div class="stat"><span class="muted">Quantity on save</span><strong>${escapeHtml(String(analysis.quantity || 1))}</strong></div>
      <div class="stat"><span class="muted">Last sold</span><strong>Check Discogs release page</strong></div>
      <div class="stat"><span class="muted">Median price (AUD)</span><strong>${money(analysis.medianAud)}</strong></div>
      <div class="stat"><span class="muted">Lowest listing (AUD)</span><strong>${money(analysis.lowestAud)}</strong></div>
      <div class="stat"><span class="muted">Discogs reference price</span><strong>${money(analysis.discogsReferenceAud)}</strong></div>
      <div class="stat"><span class="muted">eBay AU median</span><strong>${money(analysis.ebayMedian)}</strong></div>
      <div class="stat"><span class="muted">Quick-sale price</span><strong>${money(analysis.quickSalePrice)}</strong></div>
      <div class="stat"><span class="muted">Max-profit price</span><strong>${money(analysis.maxProfitPrice)}</strong></div>
      <div class="stat"><span class="muted">Demand ratio</span><strong>${Number.isFinite(analysis.demandRatio) ? analysis.demandRatio.toFixed(2) : '—'}</strong></div>
      <div class="stat"><span class="muted">Want / For sale</span><strong>${analysis.want} / ${analysis.numForSale}</strong></div>
    </div>
  `;

  if (rec.label === 'Buy' || rec.label === 'Strong Buy' || rec.label === 'Maybe') {
    showDecisionFlash(rec.label);
  }
}

function toggleDetails() {
  const panel = getEl('detailsPanel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function recalculateRecommendation() {
  if (!selectedAnalysis) return;
  selectedAnalysis.ebayMedian = getNumber('ebayMedian');
  selectedAnalysis.priceBlendMode = getEl('priceBlendMode')?.value || 'discogs';
  selectedAnalysis.referenceAud = getBlendedReferencePrice(selectedAnalysis.discogsReferenceAud);
  const discogsBasis = selectedAnalysis.medianAud > 0 ? 'Median sales history' : (selectedAnalysis.lowestAud > 0 ? 'Lowest current listing' : 'No usable market data');
  selectedAnalysis.priceBasis = getPriceBasisLabel(discogsBasis, selectedAnalysis.referenceAud);
  const strategy = buildListingStrategy(selectedAnalysis.referenceAud, selectedAnalysis.lowestAud, selectedAnalysis.demand);
  const balancedMath = strategy.balanced > 0 ? calculateProfitFromSellPrice(strategy.balanced) : { discogsCost: 0, paypalCost: 0, profit: null };
  const quickMath = strategy.quickSale > 0 ? calculateProfitFromSellPrice(strategy.quickSale) : { profit: null };
  const maxMath = strategy.maxProfit > 0 ? calculateProfitFromSellPrice(strategy.maxProfit) : { profit: null };
  selectedAnalysis.buyPrice = getNumber('buyPrice');
  selectedAnalysis.suggestedSellPrice = strategy.balanced;
  selectedAnalysis.quickSalePrice = strategy.quickSale;
  selectedAnalysis.maxProfitPrice = strategy.maxProfit;
  selectedAnalysis.discogsCost = balancedMath.discogsCost;
  selectedAnalysis.paypalCost = balancedMath.paypalCost;
  selectedAnalysis.profit = balancedMath.profit;
  selectedAnalysis.quickProfit = quickMath.profit;
  selectedAnalysis.maxProfit = maxMath.profit;
  const rec = strategy.balanced > 0 ? scoreRecommendation(selectedAnalysis.profit, selectedAnalysis.demand, true, selectedAnalysis.formatCategory) : { label: 'No market data', cls: 'skip' };
  selectedAnalysis.recommendation = rec.label;
  renderRecommendation(selectedAnalysis, rec);
}

/* =========================
   INVENTORY
========================= */

function sanitiseInventoryItem(item = {}) {
  const quantity = Math.max(1, Math.floor(normaliseNumber(item.quantity, 1)));
  const status = INVENTORY_STATUSES.includes(item.status) ? item.status : 'To clean';

  return {
    ...item,
    status,
    quantity,
    listPriceAud: normaliseNumber(item.listPriceAud, normaliseNumber(item.suggestedSellPrice, 0)),
    profit: item.profit == null ? null : normaliseNumber(item.profit, 0),
    suggestedSellPrice: normaliseNumber(item.suggestedSellPrice, 0),
    buyPrice: normaliseNumber(item.buyPrice, 0),
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    mediaCondition: item.mediaCondition || '',
    sleeveCondition: item.sleeveCondition || '',
    comment: item.comment || '',
    title: item.title || 'Untitled item',
    formatCategory: item.formatCategory || 'Other',
    recommendation: item.recommendation || '—'
  };
}

function loadInventory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(inventoryKey) || '[]');
    return Array.isArray(parsed) ? parsed.map(sanitiseInventoryItem) : [];
  } catch {
    return [];
  }
}

function saveInventory(items) {
  const clean = (Array.isArray(items) ? items : []).map((item) => sanitiseInventoryItem(item)).slice(0, 500);
  localStorage.setItem(inventoryKey, JSON.stringify(clean));
}

function getInventoryFilterState() {
  return {
    search: (getEl('inventorySearch')?.value || '').trim().toLowerCase(),
    status: getEl('inventoryStatusFilter')?.value || 'All',
    format: getEl('inventoryFormatFilter')?.value || 'All',
    sort: getEl('inventorySort')?.value || 'newest'
  };
}

function applyInventoryFilters(items) {
  const { search, status, format, sort } = getInventoryFilterState();

  const filtered = items.filter((item) => {
    const matchesSearch = !search || [
      item.title,
      item.catno,
      item.barcode,
      item.comment,
      item.mediaCondition,
      item.sleeveCondition
    ].some((value) => String(value || '').toLowerCase().includes(search));

    const matchesStatus = status === 'All' || item.status === status;
    const matchesFormat = format === 'All' || (item.formatCategory || 'Other') === format;

    return matchesSearch && matchesStatus && matchesFormat;
  });

  filtered.sort((a, b) => {
    if (sort === 'title-az') return String(a.title || '').localeCompare(String(b.title || ''));
    if (sort === 'title-za') return String(b.title || '').localeCompare(String(a.title || ''));
    if (sort === 'profit-high') return normaliseNumber(b.profit, -999999) - normaliseNumber(a.profit, -999999);
    if (sort === 'profit-low') return normaliseNumber(a.profit, 999999) - normaliseNumber(b.profit, 999999);
    if (sort === 'price-high') return normaliseNumber(b.listPriceAud || b.suggestedSellPrice, -999999) - normaliseNumber(a.listPriceAud || a.suggestedSellPrice, -999999);
    if (sort === 'price-low') return normaliseNumber(a.listPriceAud || a.suggestedSellPrice, 999999) - normaliseNumber(b.listPriceAud || b.suggestedSellPrice, 999999);
    if (sort === 'qty-high') return normaliseNumber(b.quantity, 0) - normaliseNumber(a.quantity, 0);
    if (sort === 'status') return String(a.status || '').localeCompare(String(b.status || ''));
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  return filtered;
}

function showInventoryPage() {
  getEl('inventoryPage')?.classList.remove('hidden');
  getEl('opShopPage')?.classList.add('hidden');
  document.querySelector('.wrap')?.classList.add('hidden');
  renderInventoryManager();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideInventoryPage() {
  getEl('inventoryPage')?.classList.add('hidden');
  document.querySelector('.wrap')?.classList.remove('hidden');
  renderInventory();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateInventorySummary(items) {
  const el = getEl('inventorySummaryText');
  if (!el) return;

  const totalTitles = items.length;
  const totalUnits = items.reduce((sum, item) => sum + Math.max(1, normaliseNumber(item.quantity, 1)), 0);
  const listedUnits = items
    .filter((item) => item.status === 'Listed')
    .reduce((sum, item) => sum + Math.max(1, normaliseNumber(item.quantity, 1)), 0);
  const soldUnits = items
    .filter((item) => item.status === 'Sold')
    .reduce((sum, item) => sum + Math.max(1, normaliseNumber(item.quantity, 1)), 0);

  el.textContent = totalTitles
    ? `${totalTitles} title${totalTitles === 1 ? '' : 's'} • ${totalUnits} unit${totalUnits === 1 ? '' : 's'} • Listed: ${listedUnits} • Sold: ${soldUnits}`
    : 'No saved items yet.';
}

function renderInventory() {
  const items = loadInventory();
  const area = getEl('inventoryArea');
  if (!area) return;

  updateInventorySummary(items);

  if (!items.length) {
    area.innerHTML = 'No saved items yet.';
    return;
  }

  const previewItems = items.slice(0, 3).map((item) => {
    const qty = Math.max(1, normaliseNumber(item.quantity, 1));
    return `${escapeHtml(item.title)} — ${escapeHtml(item.status)} • Qty ${qty} • ${item.profit == null ? '—' : money(item.profit)}`;
  }).join('<br>');

  area.innerHTML = `${previewItems}${items.length > 3 ? '<br>…' : ''}`;
}

function renderInventoryManager() {
  const items = loadInventory();
  const area = getEl('inventoryManagerArea');
  if (!area) return;

  updateInventorySummary(items);

  if (!items.length) {
    area.innerHTML = '<div class="card"><div class="empty">No saved items yet.</div></div>';
    return;
  }

  const filtered = applyInventoryFilters(items);

  const filteredSummary = getEl('inventoryFilteredSummary');
  if (filteredSummary) {
    filteredSummary.textContent = filtered.length === items.length
      ? `Showing all ${items.length} item${items.length === 1 ? '' : 's'}.`
      : `Showing ${filtered.length} of ${items.length} item${items.length === 1 ? '' : 's'}.`;
  }

  if (!filtered.length) {
    area.innerHTML = '<div class="card"><div class="empty">No inventory items match the current filters.</div></div>';
    return;
  }

  area.innerHTML = filtered.map((item) => {
    const originalIndex = items.findIndex((source) =>
      source.createdAt === item.createdAt &&
      source.id === item.id &&
      source.title === item.title
    );
    const qty = Math.max(1, normaliseNumber(item.quantity, 1));

    return `
      <div class="card inventory-card">
        <h3>${escapeHtml(item.title)}</h3>
        <div class="inventory-meta">
          ${escapeHtml(item.formatCategory || 'Other')} • ${escapeHtml(item.recommendation || '—')} • Status: ${escapeHtml(item.status)} • Qty: ${qty} • Estimated profit: ${item.profit == null ? '—' : money(item.profit)}
        </div>

        <div class="inventory-grid">
          <div>
            <label>Status</label>
            <select onchange="updateInventoryField(${originalIndex}, 'status', this.value)">
              ${INVENTORY_STATUSES.map((status) => `
                <option value="${escapeHtml(status)}" ${item.status === status ? 'selected' : ''}>${escapeHtml(status)}</option>
              `).join('')}
            </select>
          </div>

          <div>
            <label>Quantity</label>
            <input type="number" min="1" step="1" value="${qty}" oninput="updateInventoryField(${originalIndex}, 'quantity', this.value)" />
          </div>

          <div>
            <label>List price (AUD)</label>
            <input type="number" step="0.01" value="${escapeHtml(String(item.listPriceAud || item.suggestedSellPrice || ''))}" oninput="updateInventoryField(${originalIndex}, 'listPriceAud', this.value)" />
          </div>

          <div>
            <label>Media condition</label>
            <input type="text" value="${escapeHtml(item.mediaCondition || '')}" oninput="updateInventoryField(${originalIndex}, 'mediaCondition', this.value)" placeholder="VG+, NM, etc" />
          </div>

          <div>
            <label>Cover / sleeve / booklet condition</label>
            <input type="text" value="${escapeHtml(item.sleeveCondition || '')}" oninput="updateInventoryField(${originalIndex}, 'sleeveCondition', this.value)" placeholder="VG+, NM, etc" />
          </div>

          <div>
            <label>Comment</label>
            <textarea oninput="updateInventoryField(${originalIndex}, 'comment', this.value)" placeholder="Notes about condition, edition, inserts, etc">${escapeHtml(item.comment || '')}</textarea>
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <button type="button" class="secondary" onclick="openDiscogsUrl('${item.discogsUrl || ''}')">Show in Discogs</button>
          <button type="button" class="secondary" onclick="showListForSale(${originalIndex})">Prep Listing</button>
          <button type="button" class="secondary" onclick="removeInventoryItem(${originalIndex})">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

function updateInventoryField(index, field, value) {
  const items = loadInventory();
  if (!items[index]) return;

  if (field === 'quantity') {
    items[index][field] = Math.max(1, Math.floor(normaliseNumber(value, 1)));
  } else if (field === 'listPriceAud') {
    items[index][field] = normaliseNumber(value, 0);
  } else if (field === 'status') {
    items[index][field] = INVENTORY_STATUSES.includes(value) ? value : 'To clean';
  } else {
    items[index][field] = value;
  }

  items[index].updatedAt = new Date().toISOString();
  saveInventory(items);
  updateInventorySummary(items);
  renderInventory();
}

function exportInventoryCsv() {
  const items = loadInventory();
  if (!items.length) {
    setStatus('No inventory to export.');
    return;
  }

  const headers = [
    'title',
    'status',
    'quantity',
    'format',
    'discogs_release_url',
    'barcode',
    'catalog_number',
    'buy_price_aud',
    'list_price_aud',
    'media_condition',
    'sleeve_condition',
    'comment',
    'recommendation',
    'estimated_profit_aud',
    'created_at',
    'updated_at'
  ];

  const escapeCsv = (value) => {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
  };

  const rows = items.map((item) => [
    item.title,
    item.status || '',
    item.quantity || 1,
    item.formatCategory || '',
    item.discogsUrl || '',
    item.barcode || '',
    item.catno || '',
    item.buyPrice || '',
    item.listPriceAud || item.suggestedSellPrice || '',
    item.mediaCondition || '',
    item.sleeveCondition || '',
    item.comment || '',
    item.recommendation || '',
    item.profit == null ? '' : item.profit,
    item.createdAt || '',
    item.updatedAt || ''
  ]);

  const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'jas-and-dad-inventory.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showListForSale(index) {
  const items = loadInventory();
  const item = items[index];
  if (!item) return;

  const mediaCondition = prompt('Media condition (example: Mint (M), Near Mint (NM or M-), Very Good Plus (VG+))', item.mediaCondition || 'Very Good Plus (VG+)');
  if (mediaCondition == null) return;

  const sleeveCondition = prompt('Sleeve condition (optional for formats with sleeves)', item.sleeveCondition || 'Very Good Plus (VG+)');
  if (sleeveCondition == null) return;

  const price = prompt('Listing price in AUD', item.suggestedSellPrice || item.quickSalePrice || '5.00');
  if (price == null) return;

  item.mediaCondition = mediaCondition;
  item.sleeveCondition = sleeveCondition;
  item.listPriceAud = normaliseNumber(price, item.suggestedSellPrice || 0);
  item.status = 'Listed';
  item.updatedAt = new Date().toISOString();

  saveInventory(items);
  renderInventory();
  renderInventoryManager();

  alert('Prepared listing details locally. The browser prototype can open the Discogs release page, but creating a live Marketplace listing should be done through a backend OAuth flow, not directly in this phone page.');
}

function removeInventoryItem(index) {
  const items = loadInventory();
  const item = items[index];
  if (!item) return;
  const ok = confirm(`Remove ${item.title} from inventory?`);
  if (!ok) return;
  items.splice(index, 1);
  saveInventory(items);
  renderInventory();
  renderInventoryManager();
  setStatus('Removed from inventory.');
}

function saveItem() {
  if (!selectedAnalysis) {
    setStatus('Nothing to save yet. Analyse a release first.');
    return;
  }

  const items = loadInventory();
  items.unshift({
    ...selectedAnalysis,
    status: selectedAnalysis.status || 'To clean',
    quantity: Math.max(1, normaliseNumber(selectedAnalysis.quantity, 1)),
    listPriceAud: normaliseNumber(selectedAnalysis.listPriceAud, selectedAnalysis.suggestedSellPrice || 0),
    updatedAt: new Date().toISOString()
  });

  saveInventory(items);
  renderInventory();
  renderInventoryManager();
  setStatus('Saved to local inventory.');
}

/* =========================
   OP SHOP TRACKER
========================= */

function sanitiseOpShop(item = {}) {
  return {
    id: item.id || `shop_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    shopName: item.shopName || '',
    suburb: item.suburb || '',
    lastVisited: item.lastVisited || '',
    revisitInterval: Math.max(1, Math.floor(normaliseNumber(item.revisitInterval, 14))),
    notes: item.notes || '',
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
  };
}

function loadOpShops() {
  try {
    const parsed = JSON.parse(localStorage.getItem(opShopKey) || '[]');
    return Array.isArray(parsed) ? parsed.map(sanitiseOpShop) : [];
  } catch {
    return [];
  }
}

function saveOpShops(items) {
  const clean = (Array.isArray(items) ? items : []).map(sanitiseOpShop).slice(0, 500);
  localStorage.setItem(opShopKey, JSON.stringify(clean));
}

function getTodayYmd() {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ymdToDate(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetweenYmd(fromYmd, toYmd = getTodayYmd()) {
  const from = ymdToDate(fromYmd);
  const to = ymdToDate(toYmd);
  if (!from || !to) return null;
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function getOpShopDueState(shop) {
  const interval = Math.max(1, normaliseNumber(shop.revisitInterval, 14));
  if (!shop.lastVisited) {
    return {
      label: 'Due',
      className: 'due',
      daysUntilDue: -999,
      nextVisitText: 'No visit logged yet'
    };
  }

  const daysSince = daysBetweenYmd(shop.lastVisited);
  if (daysSince == null) {
    return {
      label: 'Unknown',
      className: 'unknown',
      daysUntilDue: 999,
      nextVisitText: 'Invalid date'
    };
  }

  const daysUntilDue = interval - daysSince;

  if (daysUntilDue <= 0) {
    return {
      label: 'Due',
      className: 'due',
      daysUntilDue,
      nextVisitText: `Due now (${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? '' : 's'} overdue)`
    };
  }

  if (daysUntilDue <= 3) {
    return {
      label: 'Due soon',
      className: 'due-soon',
      daysUntilDue,
      nextVisitText: `Due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`
    };
  }

  return {
    label: 'OK',
    className: 'ok',
    daysUntilDue,
    nextVisitText: `Due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`
  };
}

function updateOpShopSummary(shops) {
  const el = getEl('opShopSummaryText');
  if (!el) return;

  if (!shops.length) {
    el.textContent = 'No op shops saved yet.';
    return;
  }

  const dueCount = shops.filter((shop) => getOpShopDueState(shop).label === 'Due').length;
  const soonCount = shops.filter((shop) => getOpShopDueState(shop).label === 'Due soon').length;

  el.textContent = `${shops.length} shop${shops.length === 1 ? '' : 's'} • Due: ${dueCount} • Due soon: ${soonCount}`;
}

function showOpShopPage() {
  getEl('opShopPage')?.classList.remove('hidden');
  getEl('inventoryPage')?.classList.add('hidden');
  document.querySelector('.wrap')?.classList.add('hidden');
  renderOpShopTracker();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideOpShopPage() {
  getEl('opShopPage')?.classList.add('hidden');
  document.querySelector('.wrap')?.classList.remove('hidden');
  updateOpShopSummary(loadOpShops());
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderOpShopTracker() {
  const area = getEl('opShopArea');
  if (!area) return;

  const shops = loadOpShops();
  updateOpShopSummary(shops);

  if (!shops.length) {
    area.innerHTML = '<div class="card"><div class="empty">No op shops saved yet.</div></div>';
    return;
  }

  const sorted = [...shops].sort((a, b) => {
    const aDue = getOpShopDueState(a).daysUntilDue;
    const bDue = getOpShopDueState(b).daysUntilDue;
    if (aDue !== bDue) return aDue - bDue;
    return String(a.shopName || '').localeCompare(String(b.shopName || ''));
  });

  area.innerHTML = sorted.map((shop) => {
    const due = getOpShopDueState(shop);

    return `
      <div class="card inventory-card">
        <h3>${escapeHtml(shop.shopName || 'Unnamed shop')}</h3>
        <div class="inventory-meta">
          ${escapeHtml(shop.suburb || 'No suburb')} • Last visited: ${escapeHtml(shop.lastVisited || 'Never')} • Every ${escapeHtml(String(shop.revisitInterval))} day${shop.revisitInterval === 1 ? '' : 's'}
        </div>

        <div class="row" style="margin:8px 0 12px;">
          <span class="pill ${escapeHtml(due.className)}">${escapeHtml(due.label)}</span>
          <span class="small">${escapeHtml(due.nextVisitText)}</span>
        </div>

        <div class="inventory-grid">
          <div>
            <label>Notes</label>
            <textarea oninput="updateOpShopField('${shop.id}', 'notes', this.value)" placeholder="Stock quality, staff, best day, parking, etc">${escapeHtml(shop.notes || '')}</textarea>
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <button type="button" class="secondary" onclick="markOpShopVisited('${shop.id}')">Mark visited today</button>
          <button type="button" class="secondary" onclick="editOpShop('${shop.id}')">Edit</button>
          <button type="button" class="secondary" onclick="removeOpShop('${shop.id}')">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

function addOrUpdateOpShop() {
  const shopName = (getEl('shopName')?.value || '').trim();
  const suburb = (getEl('shopSuburb')?.value || '').trim();
  const lastVisited = (getEl('shopLastVisited')?.value || '').trim();
  const revisitInterval = Math.max(1, Math.floor(normaliseNumber(getEl('shopRevisitInterval')?.value, 14)));
  const notes = (getEl('shopNotes')?.value || '').trim();

  if (!shopName) {
    alert('Enter a shop name.');
    return;
  }

  const shops = loadOpShops();

  if (editingOpShopId) {
    const index = shops.findIndex((shop) => shop.id === editingOpShopId);
    if (index >= 0) {
      shops[index] = sanitiseOpShop({
        ...shops[index],
        shopName,
        suburb,
        lastVisited,
        revisitInterval,
        notes,
        updatedAt: new Date().toISOString()
      });
    }
    editingOpShopId = null;
  } else {
    shops.unshift(sanitiseOpShop({
      id: `shop_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      shopName,
      suburb,
      lastVisited,
      revisitInterval,
      notes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  saveOpShops(shops);
  clearOpShopForm();
  renderOpShopTracker();
}

function editOpShop(id) {
  const shops = loadOpShops();
  const shop = shops.find((entry) => entry.id === id);
  if (!shop) return;

  editingOpShopId = id;
  if (getEl('shopName')) getEl('shopName').value = shop.shopName || '';
  if (getEl('shopSuburb')) getEl('shopSuburb').value = shop.suburb || '';
  if (getEl('shopLastVisited')) getEl('shopLastVisited').value = shop.lastVisited || '';
  if (getEl('shopRevisitInterval')) getEl('shopRevisitInterval').value = String(shop.revisitInterval || 14);
  if (getEl('shopNotes')) getEl('shopNotes').value = shop.notes || '';

  const btn = getEl('saveOpShopBtn');
  if (btn) btn.textContent = 'Update shop';
}

function clearOpShopForm() {
  editingOpShopId = null;
  if (getEl('shopName')) getEl('shopName').value = '';
  if (getEl('shopSuburb')) getEl('shopSuburb').value = '';
  if (getEl('shopLastVisited')) getEl('shopLastVisited').value = '';
  if (getEl('shopRevisitInterval')) getEl('shopRevisitInterval').value = '14';
  if (getEl('shopNotes')) getEl('shopNotes').value = '';

  const btn = getEl('saveOpShopBtn');
  if (btn) btn.textContent = 'Add shop';
}

function updateOpShopField(id, field, value) {
  const shops = loadOpShops();
  const index = shops.findIndex((shop) => shop.id === id);
  if (index < 0) return;
  shops[index][field] = value;
  shops[index].updatedAt = new Date().toISOString();
  saveOpShops(shops);
  updateOpShopSummary(shops);
}

function markOpShopVisited(id) {
  const shops = loadOpShops();
  const index = shops.findIndex((shop) => shop.id === id);
  if (index < 0) return;
  shops[index].lastVisited = getTodayYmd();
  shops[index].updatedAt = new Date().toISOString();
  saveOpShops(shops);
  renderOpShopTracker();
}

function removeOpShop(id) {
  const shops = loadOpShops();
  const shop = shops.find((entry) => entry.id === id);
  if (!shop) return;

  const ok = confirm(`Remove ${shop.shopName} from the op shop tracker?`);
  if (!ok) return;

  const next = shops.filter((entry) => entry.id !== id);
  saveOpShops(next);

  if (editingOpShopId === id) {
    clearOpShopForm();
  }

  renderOpShopTracker();
}

/* =========================
   LOOKUP HELPERS
========================= */

function clearLookup() {
  stopBarcodeScan();
  const fields = ['barcode', 'catno', 'artist', 'album'];
  fields.forEach((id) => {
    const el = getEl(id);
    if (el) el.value = '';
  });
  if (getEl('formatFilter')) getEl('formatFilter').value = '';
  if (getEl('ebayMedian')) getEl('ebayMedian').value = '0';
  if (getEl('priceBlendMode')) getEl('priceBlendMode').value = 'discogs';
  currentCandidates = [];
  selectedAnalysis = null;
  candidateCollapsed = false;
  getEl('candidateArea').innerHTML = '<div class="empty">No Discogs results yet.</div>';
  getEl('recommendationArea').innerHTML = '<div class="empty">Select a Discogs release to analyse it.</div>';
  setStatus('Ready.');
}

function useSampleBarcode() {
  if (getEl('barcode')) getEl('barcode').value = '731452422829';
  if (getEl('catno')) getEl('catno').value = '7243 8 45599 2 5';
  if (getEl('artist')) getEl('artist').value = 'Massive Attack';
  if (getEl('album')) getEl('album').value = 'Mezzanine';
  if (getEl('formatFilter')) getEl('formatFilter').value = 'CD';
  if (getEl('ebayMedian')) getEl('ebayMedian').value = '9.50';
  if (getEl('priceBlendMode')) getEl('priceBlendMode').value = 'max';
  setStatus('Sample loaded. Tap Lookup Discogs.');
}

async function startBarcodeScan() {
  if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
    setStatus('Camera access is not available in this browser.');
    return;
  }
  if (!('BarcodeDetector' in window)) {
    setStatus('Barcode scanning is not supported in this browser yet. Enter the barcode manually.');
    return;
  }

  toggleLookupPanel(false);

  try {
    stopBarcodeScan();
    const preview = getEl('preview');
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    preview.srcObject = currentStream;
    preview.style.display = 'block';
    await preview.play();
    preview.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    setStatus('Scanning… point camera at barcode.');

    const scanFrame = async () => {
      if (!currentStream) return;
      try {
        const codes = await detector.detect(preview);
        if (codes.length > 0) {
          const value = codes[0].rawValue || '';
          if (value) {
            if (getEl('barcode')) getEl('barcode').value = value;
            setStatus(`Scanned ${value}. Looking up Discogs…`);
            stopBarcodeScan();
            lookupDiscogs();
            return;
          }
        }
      } catch (e) {
        console.log('scan error', e);
      }
      scanLoopHandle = requestAnimationFrame(scanFrame);
    };

    scanLoopHandle = requestAnimationFrame(scanFrame);
  } catch (err) {
    setStatus(`Camera access failed: ${err.message}`);
    stopBarcodeScan();
  }
}

function stopBarcodeScan() {
  if (scanLoopHandle) {
    cancelAnimationFrame(scanLoopHandle);
    scanLoopHandle = null;
  }
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  const preview = getEl('preview');
  if (preview) {
    try {
      preview.pause();
    } catch {
      // ignore
    }
    preview.srcObject = null;
    preview.style.display = 'none';
  }
}

/* =========================
   EVENTS
========================= */

document.addEventListener('input', (e) => {
  const id = e.target?.id;

  if (['buyPrice', 'discogsFee', 'paypalPct', 'paypalFixed', 'ebayMedian'].includes(id)) {
    recalculateRecommendation();
  }

  if (id === 'inventorySearch') {
    renderInventoryManager();
  }
});

document.addEventListener('change', (e) => {
  const id = e.target?.id;

  if (id === 'priceBlendMode') {
    recalculateRecommendation();
  }

  if (['inventoryStatusFilter', 'inventoryFormatFilter', 'inventorySort'].includes(id)) {
    renderInventoryManager();
  }
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = getEl('installBtn');
  const status = getEl('installStatus');
  if (btn) btn.style.display = 'inline-block';
  if (status) status.textContent = 'Install is available. Tap the button to install the app.';
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = getEl('installBtn');
  const status = getEl('installStatus');
  if (btn) btn.style.display = 'none';
  if (status) status.textContent = 'App installed.';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.log('SW failed', err));
  });
}

/* =========================
   INIT
========================= */

loadPrefs();
toggleLookupPanel(true);
renderInventory();
renderInventoryManager();
updateOpShopSummary(loadOpShops());
