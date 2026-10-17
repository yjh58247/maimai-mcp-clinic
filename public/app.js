import { selectionFromTrace, requestTemplate } from './context.mjs';
import { recordValidationError } from './records.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const pretty = value => JSON.stringify(value ?? null, null, 2);
const state = { mode: 'demo', page: 'overview', report: null, labReport: null, cases: [], reports: [], status: null, busy: false, payload: 'output', callIndex: 0, stores: [], products: [], selectedStore: '', selectedProduct: '', activeContext: {}, liveReport: null };
let toastTimer;

function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 4200);
}
async function api(path, body) {
  const response = await fetch(path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '请求未成功。'); error.data = data; throw error; }
  return data;
}
function setBusy(busy) {
  state.busy = busy;
  ['#run-case', '#hero-run', '#inspect-button', '#live-call-button', '#connect-button', '#case-select', '#mode-demo', '#mode-live', '#import-button', '#tool-select', '#store-picker', '#product-picker', '#fill-sample', '#input-json', '#output-json', '#displayed-total', '#edit-call'].forEach(selector => $(selector).disabled = busy);
  $('#run-case span').textContent = busy ? '检查中…' : '运行体检';
}
function go(page) {
  const changed = state.page !== page;
  state.page = page;
  $$('.page').forEach(element => element.classList.toggle('hidden', element.id !== 'page-' + page));
  $$('.nav-item[data-page]').forEach(button => { const active = button.dataset.page === page; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); });
  const labels = { overview: ['体检总览', '每一步调用，都心中有数', '从接入到核价，帮你找到问题发生的那一步。'], diagnose: ['调用诊断', '把问题留在发送之前', '检查参数，也检查已经取得的响应。'], reports: ['报告回放', '每一次排查，都有迹可循', '导出脱敏报告，让问题可以复现、可以讨论。'] }[page];
  $('#crumb').textContent = labels[0];
  $('#page-title').innerHTML = esc(labels[1]) + '<span class="heading-dot">.</span>';
  $('#page-subtitle').textContent = labels[2];
  if (page === 'reports') refreshReports().catch(error => toast(error.message));
  if (page === 'diagnose') renderLab();
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
}
function switchMode(mode) {
  if (state.busy) return;
  state.mode = mode;
  ['demo', 'live'].forEach(name => { $('#mode-' + name).classList.toggle('selected', mode === name); $('#mode-' + name).setAttribute('aria-pressed', String(mode === name)); });
  $('#live-banner').classList.toggle('hidden', mode !== 'live');
  $('#live-call-button').classList.toggle('hidden', mode !== 'live');
  $('#editor-mode-caption').textContent = mode === 'live' ? '发送前会做参数检查；仅执行当前选择的一个工具。' : '仅在本机分析，不向 MCP 发送请求。';
  updateLiveText();
  updatePickers(mode === 'live' ? state.liveReport : state.report?.source === 'demo' ? state.report : null);
}
function updateLiveText() {
  $('#live-text').textContent = state.status?.connected ? 'MCP 已连接。前往调用诊断，逐步查询门店、菜单与报价。' : state.status?.tokenConfigured ? '已检测到本机 Token。点击检查连接，读取当前工具与服务器时间。' : '尚未配置本机 Token。打开接入文档，完成配置并重启服务。';
  $('#connect-button').innerHTML = (state.status?.tokenConfigured ? '检查连接' : '查看接入指南') + icon('arrow');
}
function findingHtml(item) {
  return '<article class="finding-card ' + esc(item.severity) + '"><div class="finding-header"><span class="severity">' + (item.severity === 'error' ? '需修复' : '需确认') + '</span><span>' + esc(item.title) + '</span></div><p>' + esc(item.detail) + '</p><div class="finding-fix"><b>建议</b>' + esc(item.fix) + '</div><div class="finding-meta"><span>' + esc(item.code) + '</span><button class="inline-button" data-call="' + Number(item.callIndex) + '">查看调用 ↗</button></div></article>';
}
function noFindingsHtml() {
  return '<div class="finding-empty">' + icon('check') + '<h3>当前记录，检查通过</h3><p>未发现已覆盖的规则问题。<br>这不代表完整业务已通过验收。</p></div>';
}
function renderReport(report, revealCount = null) {
  state.report = report;
  const summary = report.summary;
  $('#stat-total').textContent = summary.total;
  $('#stat-passed').textContent = summary.passed;
  $('#stat-issues').textContent = report.findings.length;
  $('#stat-time').textContent = summary.timedCalls ? (summary.durationMs / 1000).toFixed(2) : '—';
  $('#stat-time-note').textContent = !summary.timedCalls ? '当前记录未包含调用耗时' : report.source === 'demo' ? '演示耗时 · 非实时性能测试' : '记录内调用耗时合计';
  $('#stat-issues-note').textContent = summary.errors + '项需修复 · ' + summary.warnings + '项需确认';
  $('#flow-source').textContent = report.sourceLabel;
  $('#flow-description').textContent = report.title;
  const calls = revealCount == null ? report.calls : report.calls.slice(0, revealCount);
  $('#flow-list').innerHTML = calls.map((call, index) => '<button class="flow-row ' + esc(call.status) + (revealCount == null ? '' : ' revealing') + '" data-call="' + index + '"><span class="flow-number">' + String(index + 1).padStart(2, '0') + '</span><span class="flow-status-icon">' + icon(call.status === 'passed' ? 'check' : 'alert') + '</span><span class="flow-name"><strong>' + esc(call.label) + '</strong><small>' + esc(call.tool) + '</small></span><span class="flow-badge">' + (call.status === 'passed' ? '通过' : call.findings.length + '项问题') + '</span><span class="flow-duration">' + (call.durationMs ?? '—') + ' ms</span></button>').join('');
  $('#findings').innerHTML = report.findings.length ? [...report.findings].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1)).map(findingHtml).join('') : noFindingsHtml();
  $('#finding-count').textContent = report.findings.length;
  $('#flow-status').textContent = revealCount != null ? '正在回放离线记录，未发送真实请求…' : report.source === 'demo' ? '案例回放完成 · 菜单与价格为虚构数据' : report.sourceLabel + ' · 记录范围内检查完成';
  $('#flow-dot').classList.toggle('green', !report.findings.length);
  if (revealCount == null) updatePickers(state.mode === 'live' ? state.liveReport : report);
}
function renderCases() {
  $('#case-select').innerHTML = state.cases.map(item => '<option value="' + esc(item.id) + '">' + esc(item.title) + '</option>').join('');
  $('#case-cards').innerHTML = state.cases.filter(item => item.id !== 'price-unit').map((item, i) => '<button class="case-card" data-case="' + esc(item.id) + '"><div class="case-card-top"><span class="case-card-icon">' + icon(['plug', 'check', 'lock'][i]) + '</span><small>' + esc(item.tag) + '</small></div><h3>' + esc(item.title) + '</h3><p>' + esc(item.description) + '</p><div class="case-card-bottom"><span>' + esc(item.subtitle) + '</span>' + icon('arrow') + '</div></button>').join('');
}
async function runCase(caseId = $('#case-select').value) {
  if (state.busy) return;
  switchMode('demo'); go('overview'); $('#case-select').value = caseId; setBusy(true);
  try {
    const { report } = await api('/api/demo', { caseId });
    for (let count = 1; count <= report.calls.length; count++) {
      renderReport(report, count);
      await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 90));
    }
    renderReport(report); await refreshReports();
    toast(report.findings.length ? '体检完成，找到' + report.findings.length + '项待关注问题。' : '案例检查通过，可以展开每一步查看。');
  } catch (error) { toast(error.message); } finally { setBusy(false); }
}
function updatePickers(report) {
  const selection = selectionFromTrace(report?.calls || [], { storeCode: state.selectedStore, productCode: state.selectedProduct });
  Object.assign(state, selection);
  const channels = { 1: '到店自取', 2: '麦乐送', 5: '得来速', 6: '企业团餐' };
  $('#store-picker').innerHTML = state.stores.length ? state.stores.map(store => '<option value="' + esc(store.storeCode) + '">' + esc(store.storeName || store.storeCode) + ' · ' + esc(channels[store.beType] || '') + '</option>').join('') : '<option value="">暂无门店记录</option>';
  $('#store-picker').value = state.selectedStore;
  $('#product-picker').innerHTML = state.products.length ? state.products.map(item => '<option value="' + esc(item.code) + '">' + esc(item.name) + '</option>').join('') : '<option value="">暂无当前渠道与时段的菜单</option>';
  $('#product-picker').value = state.selectedProduct;
}
function fillSample() {
  const tool = $('#tool-select').value;
  const report = state.mode === 'live' ? state.liveReport : state.report;
  const input = requestTemplate(state.status.samples[tool] || {}, {
    context: state.activeContext, productCode: state.selectedProduct, calls: report?.calls || [],
  });
  $('#input-json').value = pretty(input);
  $('#output-json').value = ''; $('#displayed-total').value = '';
}
function renderLab() {
  const report = state.labReport;
  if (!report) { $('#lab-findings').innerHTML = '<div class="finding-empty">' + icon('code') + '<h3>准备好你的第一条请求</h3><p>从工具模板开始，或带入已有调用记录。</p></div>'; return; }
  $('#lab-result-note').textContent = report.sourceLabel;
  $('#lab-findings').innerHTML = report.findings.length ? report.findings.map(findingHtml).join('') : noFindingsHtml();
  const call = report.calls.at(-1);
  $('#lab-payload').textContent = pretty(state.payload === 'input' ? call?.input : call?.error || call?.output || { status: '仅检查参数，未执行工具' });
}
async function inspect(live = false) {
  if (state.busy) return;
  let input, output, displayedTotal;
  try {
    input = JSON.parse($('#input-json').value);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数应为 JSON 对象。');
    if ($('#output-json').value.trim()) output = JSON.parse($('#output-json').value);
    if ($('#displayed-total').value !== '') { displayedTotal = Number($('#displayed-total').value); if (!Number.isFinite(displayedTotal)) throw new Error('展示金额需要填写有效数字。'); }
  } catch (error) { toast(error instanceof SyntaxError ? 'JSON 格式有误，请检查引号和逗号。' : error.message); return; }
  if (live && !state.status.connected) { toast('请先在真实接入模式完成连接检查。'); return; }
  setBusy(true);
  try {
    const body = live ? { tool: $('#tool-select').value, input, displayedTotal } : { title: '手动调用检查', calls: [{ tool: $('#tool-select').value, input, output, ...(displayedTotal != null ? { meta: { displayedTotal } } : {}) }] };
    const { report } = await api(live ? '/api/live/call' : '/api/analyze', body);
    state.labReport = report;
    if (live) state.liveReport = report;
    renderReport(report); renderLab(); await refreshReports();
    toast(report.findings.length ? '已完成检查，请查看诊断建议。' : live ? '查询完成，响应已脱敏。' : '在当前参数中未发现已覆盖的规则问题。');
  } catch (error) {
    if (error.data?.report) { state.labReport = error.data.report; if (live && error.data.report.source === 'live') state.liveReport = error.data.report; renderReport(error.data.report); renderLab(); await refreshReports(); }
    toast(error.message);
  } finally { setBusy(false); }
}
async function connect() {
  if (state.busy) return;
  if (!state.status.tokenConfigured) { $('#guide-dialog').showModal(); return; }
  setBusy(true); $('#live-text').textContent = '正在握手、发现工具并读取服务器时间…';
  try {
    const data = await api('/api/live/connect', {});
    state.status.connected = true; state.liveReport = data.report; state.labReport = data.report;
    renderReport(data.report); renderLab(); await refreshReports();
    toast('已连接，发现' + data.connection.tools.length + '个 MCP 工具。');
    go('diagnose');
    $('#tool-select').value = 'query-nearby-stores'; fillSample();
  } catch (error) {
    state.status.connected = false; state.liveReport = null; updatePickers(null);
    if (error.data?.report) { state.labReport = error.data.report; renderReport(error.data.report); renderLab(); await refreshReports(); }
    toast(error.message);
  } finally { setBusy(false); updateLiveText(); }
}
function showCall(index) {
  const report = state.page === 'diagnose' ? state.labReport : state.report;
  const call = report?.calls[index]; if (!call) return;
  state.callIndex = index; state.dialogReport = report;
  $('#call-dialog-title').textContent = call.label + ' · ' + call.tool;
  $('#call-dialog-content').innerHTML = '<span class="tiny-label">' + esc(report.sourceLabel) + '</span>' + (call.findings.length ? call.findings.map(findingHtml).join('') : '') + '<h3>调用参数 · INPUT</h3><pre>' + esc(pretty(call.input)) + '</pre><h3>工具响应 · OUTPUT</h3><pre>' + esc(pretty(call.error || call.output || { note: call.note || '记录未包含响应' })) + '</pre>';
  $('#call-dialog').showModal();
}
function editCall() {
  const report = state.dialogReport, call = report.calls[state.callIndex];
  $('#call-dialog').close();
  if (report.source !== 'live') switchMode('demo');
  go('diagnose');
  $('#tool-select').value = call.tool;
  // Read-only traces may contain tools outside the executable whitelist.
  if (!$('#tool-select').value) {
    const option = document.createElement('option'); option.value = call.tool; option.textContent = call.tool + '（仅分析）'; $('#tool-select').append(option); $('#tool-select').value = call.tool;
  }
  $('#input-json').value = pretty(call.input); $('#output-json').value = call.output ? pretty(call.output) : '';
  $('#displayed-total').value = call.meta?.displayedTotal ?? '';
  if (call.output || call.meta) $('.optional-output').open = true;
  state.labReport = report; renderLab();
}
async function refreshReports() {
  state.reports = (await api('/api/reports')).reports;
  $('#report-count').textContent = state.reports.length;
  $('#reports-list').innerHTML = state.reports.length ? state.reports.map(report => '<button class="report-row" data-report="' + esc(report.id) + '"><span><strong>' + esc(report.title) + '</strong><small>' + esc(report.sourceLabel) + '</small></span><span class="report-time">' + esc(new Date(report.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })) + '</span><span class="report-stat">' + report.summary.total + ' calls</span><span class="report-status ' + (report.findings.length ? '' : 'clean') + '">' + (report.findings.length ? report.findings.length + '项问题' : '检查通过') + '</span></button>').join('') : '<div class="empty-reports">还没有体检记录<br>运行一个案例，或导入已有 JSON 报告。</div>';
}
function download(format) {
  if (!state.report) return toast('请先运行一次体检。');
  const report = state.report;
  const md = ['# 麦麦 MCP 体检报告', '', '- 来源：' + report.sourceLabel, '- 时间：' + report.createdAt, '- 调用：' + report.summary.total + '；问题：' + report.findings.length, '', '本报告只反映记录范围内的检查。离线与导入记录不代表实时结果。', '', ...report.findings.flatMap(item => ['## ' + item.title, '', item.detail, '', '建议：' + item.fix, '']), '## 脱敏调用记录', '', '~~~json', pretty(report.calls), '~~~', '', '已知敏感字段已脱敏；分享前请检查自由文本。'].join('\n');
  const blob = new Blob([format === 'json' ? pretty(report) : md], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'mcd-clinic-' + report.source + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + format;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出脱敏报告。分享前请检查自由文本。');
}
async function importFile(file) {
  if (!file || state.busy) return;
  setBusy(true);
  try {
    if (file.size > 1_000_000) { toast('文件超过1MB，请缩小记录范围。'); return; }
    let raw;
    try { raw = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
    catch { toast('无法读取 JSON 文件，请检查文件格式。'); return; }
    const validation = recordValidationError(raw, { reportOnly: true });
    if (validation) { toast(validation); return; }
    if (new TextEncoder().encode(JSON.stringify(raw)).length > 1_000_000) { toast('记录编码后超过1MB，请缩小范围。'); return; }
    const { report } = await api('/api/analyze', raw);
    renderReport(report); state.labReport = report; await refreshReports(); go('overview');
    toast('导入完成，已重新脱敏并检查；没有进行实时调用。');
  } catch (error) { toast(error.message); } finally { setBusy(false); $('#import-file').value = ''; }
}
document.addEventListener('click', event => {
  const navigation = event.target.closest('[data-page]'); if (navigation) go(navigation.dataset.page);
  const caseButton = event.target.closest('[data-case]'); if (caseButton) runCase(caseButton.dataset.case);
  const callButton = event.target.closest('[data-call]'); if (callButton && !callButton.closest('#call-dialog')) showCall(Number(callButton.dataset.call));
  const reportButton = event.target.closest('[data-report]'); if (reportButton) { const report = state.reports.find(r => r.id === reportButton.dataset.report); renderReport(report); state.labReport = report; go('overview'); toast('已打开记录：' + report.title); }
  const payloadButton = event.target.closest('[data-payload]'); if (payloadButton) { state.payload = payloadButton.dataset.payload; $$('.payload-tabs button').forEach(button => button.classList.toggle('active', button === payloadButton)); renderLab(); }
});
['#guide-nav', '#guide-top'].forEach(selector => $(selector).addEventListener('click', () => $('#guide-dialog').showModal()));
$('#close-guide').onclick = () => $('#guide-dialog').close();
$('#close-call').onclick = () => $('#call-dialog').close();
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } }));
$('#mode-demo').onclick = () => switchMode('demo'); $('#mode-live').onclick = () => switchMode('live');
$('#hero-run').onclick = () => state.mode === 'live' ? connect() : runCase();
$('#hero-lab').onclick = () => go('diagnose');
$('#run-case').onclick = () => runCase();
$('#connect-button').onclick = connect;
$('#case-select').onchange = () => { if (!state.busy) { const example = state.cases.find(c => c.id === $('#case-select').value); switchMode('demo'); renderReport(example.report); } };
$('#tool-select').onchange = fillSample; $('#fill-sample').onclick = fillSample;
$('#store-picker').onchange = () => { state.selectedStore = $('#store-picker').value; updatePickers(state.mode === 'live' ? state.liveReport : state.report); fillSample(); };
$('#product-picker').onchange = () => { state.selectedProduct = $('#product-picker').value; fillSample(); };
$('#inspect-button').onclick = () => inspect(false); $('#live-call-button').onclick = () => inspect(true);
$('#edit-call').onclick = editCall;
$('#export-quick').onclick = () => download('json'); $('#export-json').onclick = () => download('json'); $('#export-md').onclick = () => download('md');
$('#import-button').onclick = () => $('#import-file').click(); $('#import-file').onchange = () => importFile($('#import-file').files[0]);
$('#copy-result').onclick = async () => { if (!state.labReport) return toast('还没有可复制的报告。'); try { await navigator.clipboard.writeText(pretty(state.labReport)); toast('已复制脱敏报告。'); } catch { toast('浏览器未允许复制，请使用导出报告。'); } };
$$('textarea').forEach(textarea => textarea.addEventListener('keydown', event => { if (event.key === 'Tab') { event.preventDefault(); const at = textarea.selectionStart, end = textarea.selectionEnd; textarea.setRangeText('  ', at, end, 'end'); } }));
try {
  const [status, demos] = await Promise.all([api('/api/status'), api('/api/demos')]);
  state.status = status; state.cases = demos.cases; renderCases();
  $('#tool-select').innerHTML = status.tools.map(tool => '<option value="' + esc(tool.name) + '">' + esc(tool.name) + ' · ' + esc(tool.label) + '</option>').join('');
  renderReport(state.cases[0].report); fillSample(); renderLab(); await refreshReports(); updateLiveText();
} catch (error) { $('#flow-status').textContent = '加载失败，请确认本地服务正在运行。'; toast(error.message); }
