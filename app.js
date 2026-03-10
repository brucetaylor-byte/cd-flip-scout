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

function getEl(id) {
  return document.getElementById(id);
}

function money(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD'
  }).format(value);
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

function setStatus(message) {
  const el = getEl('lookupStatus');
  if (el) el.textContent = message;
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

function buildHeaders() {
  const headers = {
    Accept: 'application/vnd.discogs.v2.discogs+json'
  };

  const token = getEl('token')?.value.trim();
  if (token) {
    headers.Authorization = `Discogs token=${token}`;
  }

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

  if (demandLabel === 'High') {
    return roundSellPrice(Math.max(referenceAud, lowestAud || 0));
  }

  if (demandLabel === 'Medium') {
    if (Number.isFinite(lowestAud) && lowestAud > 0) {
      return roundSellPrice(Math.min(referenceAud, lowestAud + 1));
    }
    return roundSellPrice(referenceAud);
  }

  if (Number.isFinite(lowestAud) && lowestAud > 0) {
    return roundSellPrice(Math.max(lowestAud - 0.5, 0));
  }

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
  if (mode === 'max') {
    return blendedReferenceAud === ebayMedian
      ? 'eBay AU stronger than Discogs'
      : 'Discogs stronger than eBay AU';
  }
  return discogsBasis;
}

function calculateProfitFromSellPrice(sellPrice) {
  const buyPrice = getNumber('buyPrice');
  const discogsFee = getNumber('discogsFee') / 100;
  const paypalPct = getNumber('paypalPct') / 100;
  const paypalFixed = getNumber('paypalFixed');

  const discogsCost = sellPrice * discogsFee;
  const paypalCost = (sellPrice * paypalPct) + paypalFixed;
  const profit = sellPrice - discogsCost - paypalCost - buyPrice;

  return { discogsCost, paypalCost, profit };
}

async function fetchDiscogsJson(url) {
  try {
    const response = await fetch(url, {
      headers: buildHeaders(),
      mode: 'cors'
    });
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
    setStatus(
      results.length
        ? `Found ${results.length} Discogs candidate${results.length === 1 ? '' : 's'}.`
        : 'No Discogs results found.'
    );
  } catch (error) {
    setStatus(`Lookup failed: ${error.message}`);
    getEl('candidateArea').innerHTML =
      '<div class="empty">Lookup failed. Try a token, catalog number, or artist + album fallback.</div>';
  }
}

function renderCandidates(results) {
  const area = getEl('candidateArea');

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
  const releaseFormats = Array.isArray(release?.formats)
    ? release.formats.map((f) => f.name || '').filter(Boolean)
    : [];
  const itemFormats = Array.isArray(fallbackItem?.format)
    ? fallbackItem.format
    : (fallbackItem?.format ? [fallbackItem.format] : []);
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
    const discogsBasis = medianAud > 0
      ? 'Median sales history'
      : (lowestAud > 0 ? 'Lowest current listing' : 'No usable market data');

    const referenceAud = getBlendedReferencePrice(discogsReferenceAud);
    const priceBasis = getPriceBasisLabel(discogsBasis, referenceAud);
    const demand = calcDemand(stats, release);
    const formatCategory = getFormatCategory(release, item);
    const strategy = buildListingStrategy(referenceAud, lowestAud, demand.label);
    const suggestedMath = strategy.balanced > 0
      ? calculateProfitFromSellPrice(strategy.balanced)
      : { discogsCost: 0, paypalCost: 0, profit: null };
    const quickMath = strategy.quickSale > 0
      ? calculateProfitFromSellPrice(strategy.quickSale)
      : { profit: null };
    const maxMath = strategy.maxProfit > 0
      ? calculateProfitFromSellPrice(strategy.maxProfit)
      : { profit: null };
    const rec = strategy.balanced > 0
      ? scoreRecommendation(suggestedMath.profit, demand.label, true, formatCategory)
      : { label: 'No market data', cls: 'skip' };

    const title = [release.artists_sort || '', release.title || 'Untitled release']
      .filter(Boolean)
      .join(' – ');

    selectedAnalysis = {
      discogsUrl: `https://www.discogs.com/release/${item.id}`,
      id: item.id,
      title,
      barcode: getEl('barcode')?.value.trim() || '',
      catno: getEl('catno')?.value.trim() || item.catno || '',
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
      createdAt: new Date().toISOString()
    };

    candidateCollapsed = true;
    renderCandidates(currentCandidates);
    renderRecommendation(selectedAnalysis, rec);
    setStatus(`Loaded Discogs release ${item.id}.`);
  } catch (error) {
    setStatus(`Release analysis failed: ${error.message}`);
    getEl('recommendationArea').innerHTML =
      '<div class="empty">Could not load marketplace stats for this release.</div>';
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

  showDecisionFlash(rec.label);
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

  const discogsBasis = selectedAnalysis.medianAud > 0
    ? 'Median sales history'
    : (selectedAnalysis.lowestAud > 0 ? 'Lowest current listing' : 'No usable market data');

  selectedAnalysis.priceBasis = getPriceBasisLabel(discogsBasis, selectedAnalysis.referenceAud);

  const strategy = buildListingStrategy(
    selectedAnalysis.referenceAud,
    selectedAnalysis.lowestAud,
    selectedAnalysis.demand
  );

  const balancedMath = strategy.balanced > 0
    ? calculateProfitFromSellPrice(strategy.balanced)
    : { discogsCost: 0, paypalCost: 0, profit: null };
  const quickMath = strategy.quickSale > 0
    ? calculateProfitFromSellPrice(strategy.quickSale)
    : { profit: null };
  const maxMath = strategy.maxProfit > 0
    ? calculateProfitFromSellPrice(strategy.maxProfit)
    : { profit: null };

  selectedAnalysis.buyPrice = getNumber('buyPrice');
  selectedAnalysis.suggestedSellPrice = strategy.balanced;
  selectedAnalysis.quickSalePrice = strategy.quickSale;
  selectedAnalysis.maxProfitPrice = strategy.maxProfit;
  selectedAnalysis.discogsCost = balancedMath.discogsCost;
  selectedAnalysis.paypalCost = balancedMath.paypalCost;
  selectedAnalysis.profit = balancedMath.profit;
  selectedAnalysis.quickProfit = quickMath.profit;
  selectedAnalysis.maxProfit = maxMath.profit;

  const rec = strategy.balanced > 0
    ? scoreRecommendation(selectedAnalysis.profit, selectedAnalysis.demand, true, selectedAnalysis.formatCategory)
    : { label: 'No market data', cls: 'skip' };

  selectedAnalysis.recommendation = rec.label;
  renderRecommendation(selectedAnalysis, rec);
}

function loadInventory() {
  try {
    return JSON.parse(localStorage.getItem(inventoryKey) || '[]');
  } catch {
    return [];
  }
}

function saveInventory(items) {
  localStorage.setItem(inventoryKey, JSON.stringify(items.slice(0, 200)));
}

function showInventoryPage() {
  getEl('inventoryPage')?.classList.remove('hidden');
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
  const count = items.length;
  const el = getEl('inventorySummaryText');
  if (el) {
    el.textContent = count ? `${count} item${count === 1 ? '' : 's'} saved.` : 'No saved items yet.';
  }
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

  const previewItems = items
    .slice(0, 3)
    .map((item) => `${item.title} — ${item.profit == null ? '—' : money(item.profit)}`)
    .join('<br>');

  area.innerHTML = `${previewItems}${items.length > 3 ? '<br>…' : ''}`;
}

function renderInventoryManager() {
  const items = loadInventory();
  const area = getEl('inventoryManagerArea');
  if (!area) return;

  if (!items.length) {
    area.innerHTML = '<div class="card"><div class="empty">No saved items yet.</div></div>';
    return;
  }

  area.innerHTML = items.map((item, index) => `
    <div class="card inventory-card">
      <h3>${escapeHtml(item.title)}</h3>
      <div class="inventory-meta">${escapeHtml(item.formatCategory || 'Other')} • ${escapeHtml(item.recommendation || '—')} • Estimated profit: ${item.profit == null ? '—' : money(item.profit)}</div>
      <div class="inventory-grid">
        <div>
          <label>List price (AUD)</label>
          <input type="number" step="0.01" value="${escapeHtml(String(item.listPriceAud || item.suggestedSellPrice || ''))}" oninput="updateInventoryField(${index}, 'listPriceAud', this.value)" />
        </div>
        <div>
          <label>Media condition</label>
          <input type="text" value="${escapeHtml(item.mediaCondition || '')}" oninput="updateInventoryField(${index}, 'mediaCondition', this.value)" placeholder="VG+, NM, etc" />
        </div>
        <div>
          <label>Cover / sleeve / booklet condition</label>
          <input type="text" value="${escapeHtml(item.sleeveCondition || '')}" oninput="updateInventoryField(${index}, 'sleeveCondition', this.value)" placeholder="VG+, NM, etc" />
        </div>
        <div>
          <label>Comment</label>
          <textarea oninput="updateInventoryField(${index}, 'comment', this.value)" placeholder="Notes about condition, edition, inserts, etc">${escapeHtml(item.comment || '')}</textarea>
        </div>
      </div>
      <div class="row" style="margin-top:12px;">
        <button type="button" class="secondary" onclick="openDiscogsUrl('${item.discogsUrl || ''}')">Show in Discogs</button>
        <button type="button" class="secondary" onclick="removeInventoryItem(${index})">Remove</button>
      </div>
    </div>
  `).join('');
}

function updateInventoryField(index, field, value) {
  const items = loadInventory();
  if (!items[index]) return;
  items[index][field] = value;
  saveInventory(items);
  updateInventorySummary(items);
}

function exportInventoryCsv() {
  const items = loadInventory();
  if (!items.length) {
    setStatus('No inventory to export.');
    return;
  }

  const headers = [
    'title',
    'format',
    'discogs_release_url',
    'catalog_number',
    'list_price_aud',
    'media_condition',
    'sleeve_condition',
    'comment',
    'recommendation',
    'estimated_profit_aud'
  ];

  const escapeCsv = (value) => {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
  };

  const rows = items.map((item) => [
    item.title,
    item.formatCategory || '',
    item.discogsUrl || '',
    item.catno || '',
    item.listPriceAud || item.suggestedSellPrice || '',
    item.mediaCondition || '',
    item.sleeveCondition || '',
    item.comment || '',
    item.recommendation || '',
    item.profit == null ? '' : item.profit
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map(escapeCsv).join(','))
    .join('\n');

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
  items.unshift({ ...selectedAnalysis });
  saveInventory(items);
  renderInventory();
  renderInventoryManager();
  setStatus('Saved to local inventory.');
}

function clearLookup() {
  stopBarcodeScan();

  const idsToClear = ['barcode', 'catno', 'artist', 'album'];
  idsToClear.forEach((id) => {
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

    const detector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e']
    });

    setStatus('Scanning… point camera at barcode.');

    const scanFrame = async () => {
      if (!currentStream) return;

      try {
        const codes = await detector.detect(preview);

        if (codes.length) {
          const code = codes[0].rawValue || '';
          if (code) {
            getEl('barcode').value = code;
            setStatus(`Scanned ${code}. Looking up Discogs…`);
            stopBarcodeScan();
            setTimeout(() => {
              lookupDiscogs();
            }, 50);
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
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }

  const preview = getEl('preview');
  if (preview) {
    try {
      preview.pause();
    } catch (_) {
      // ignore
    }
    preview.srcObject = null;
    preview.style.display = 'none';
  }
}

document.addEventListener('input', (e) => {
  if (['buyPrice', 'discogsFee', 'paypalPct', 'paypalFixed', 'ebayMedian', 'priceBlendMode'].includes(e.target.id)) {
    recalculateRecommendation();
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
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.log('SW failed', err);
    });
  });
}

window.toggleSettings = toggleSettings;
window.toggleLookupPanel = toggleLookupPanel;
window.triggerInstall = triggerInstall;
window.openDiscogsUrl = openDiscogsUrl;
window.showCandidateInDiscogs = showCandidateInDiscogs;
window.lookupDiscogs = lookupDiscogs;
window.expandCandidates = expandCandidates;
window.selectCandidate = selectCandidate;
window.toggleDetails = toggleDetails;
window.showInventoryPage = showInventoryPage;
window.hideInventoryPage = hideInventoryPage;
window.exportInventoryCsv = exportInventoryCsv;
window.removeInventoryItem = removeInventoryItem;
window.saveItem = saveItem;
window.clearLookup = clearLookup;
window.useSampleBarcode = useSampleBarcode;
window.startBarcodeScan = startBarcodeScan;
window.updateInventoryField = updateInventoryField;

loadPrefs();
toggleLookupPanel(true);
renderInventory();
