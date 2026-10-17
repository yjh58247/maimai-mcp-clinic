// One redaction boundary for browser responses, CLI output and downloadable reports.
import { jsonFragments } from './json-text.mjs';
const privateKey = /^(?:authorization|proxyauthorization|cookie|setcookie|.*token|.*secret|.*password|apikey|.*sessionid|coupon(?:id|code)|orderid|payid|pay.*url|pickupcode|lockercode|lockerqrcode|.*(?:phone|mobile)(?:number|no)?|.*email(?:address)?|(?:customer|rider|receiver|recipient|consignee|contact).*|user(?:id|name|nickname)|.*address(?:id|detail)?|latitude|longitude|member(?:ship)?(?:id|code)|openid|unionid|accesskey)$/i;
const isPrivateKey = key => privateKey.test(key.replace(/[-_\s.]/g, ''));
const hidden = '[已脱敏]';
const truncated = '[内容过长，已截断]';

export function redact(value, secrets = []) {
  let nodes = 0;
  const actualSecrets = secrets.filter(s => typeof s === 'string' && s.length > 3);
  function maskText(text) {
    let result = text;
    for (const secret of actualSecrets) result = result.split(secret).join(hidden);
    result = result.replace(/\bBearer\s+(?!\$\{)[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${hidden}`)
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, hidden)
      .replace(/\b(?:sk|ghp|github_pat|sk-proj)[-_][A-Za-z0-9_-]{12,}\b/g, hidden)
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, hidden)
      .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, hidden)
      .replace(/((?:token|secret|password|api[_-]?key|couponCode|orderId|pickupCode)\s*[=:]\s*)[^\s&,;"']+/gi, `$1${hidden}`);
    return result;
  }
  function cleanString(text, depth) {
    let result = maskText(text);
    // Parse before truncating so that sensitive objects and arrays remain redactable.
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object') return JSON.stringify(walk(parsed, depth + 1));
    } catch {}
    const fragments = jsonFragments(result);
    if (fragments.length) {
      let at = 0, clean = '';
      for (const fragment of fragments) {
        clean += result.slice(at, fragment.start) + JSON.stringify(walk(fragment.value, depth + 1));
        at = fragment.end;
      }
      result = clean + result.slice(at);
    }
    result = result.replace(/"([^"\n]+)"(\s*:\s*)(?:"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|null|true|false)/g, (match, key, separator) => isPrivateKey(key) ? JSON.stringify(key) + separator + JSON.stringify(hidden) : match);
    return result.length > 120_000 ? result.slice(0, 120_000) + truncated : result;
  }
  function walk(item, depth) {
    if (++nodes > 40_000 || depth > 30) return truncated;
    if (typeof item === 'string') return cleanString(item, depth);
    if (item == null || typeof item !== 'object') return item;
    if (Array.isArray(item)) {
      const result = [];
      for (const value of item) { if (nodes >= 40_000) { result.push(truncated); break; } result.push(walk(value, depth + 1)); }
      return result;
    }
    const result = Object.create(null);
    for (const [key, val] of Object.entries(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (nodes >= 40_000) { result.$truncated = truncated; break; }
      result[maskText(key)] = isPrivateKey(key) ? hidden : walk(val, depth + 1);
    }
    return result;
  }
  return walk(value, 0);
}

export function markdownReport(report) {
  const safe = redactReport(report);
  const literal = value => String(value ?? '').replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}()#+.!|]/g, '\\$&');
  const lines = [
    '# 麦麦 MCP 体检报告', '',
    `- 来源：${literal(safe.sourceLabel)}`,
    `- 生成时间：${literal(safe.createdAt)}`,
    `- 调用：${safe.summary.total}；通过：${safe.summary.passed}；需关注：${safe.summary.attention}`, '',
    '本报告只反映记录范围内的检查。离线案例与导入记录不代表当前门店实时结果。', '',
    '| 级别 | 诊断 | 详情 | 建议 |', '| --- | --- | --- | --- |'
  ];
  for (const item of safe.findings) lines.push(`| ${literal(item.severity)} | ${literal(item.title)} | ${literal(item.detail)} | ${literal(item.fix)} |`);
  if (!safe.findings.length) lines.push('| — | 在当前记录中未发现规则问题 | — | 请结合完整业务流程判断 |');
  lines.push('', '## 调用记录', '', '```json', JSON.stringify(safe.calls, null, 2), '```', '', '导出已按已知敏感字段和常见凭证格式脱敏；分享前仍应检查自由文本。', '');
  return lines.join('\n');
}

// Keep the report envelope independent from payload redaction budgets. Large
// responses may be omitted, but must never remove later calls or the summary.
export function redactReport(report, secrets = []) {
  if (report?.format !== 'mcd-clinic-report' || report.schemaVersion !== 1 || !Array.isArray(report.calls) ||
      !report.summary || typeof report.summary !== 'object' || Array.isArray(report.summary))
    throw new Error('需要体检站生成的 v1 报告。');
  const encoder = new TextEncoder();
  const bytes = value => encoder.encode(JSON.stringify(value) ?? 'null').length;
  let limited = report.truncation?.truncated === true;
  const omittedFields = new Set();
  const remember = path => { limited = true; if (omittedFields.size < 100) omittedFields.add(path); };
  const text = (value, maximum, path) => {
    const clean = String(redact(String(value ?? ''), secrets));
    if (clean.includes(truncated)) remember(path);
    if (encoder.encode(clean).length <= maximum) return clean;
    remember(path);
    let result = '', length = encoder.encode(truncated).length;
    for (const character of clean) {
      const size = encoder.encode(character).length;
      if (length + size > maximum) break;
      result += character; length += size;
    }
    return result + truncated;
  };
  const payload = (value, path, maximum = 80_000) => {
    const clean = redact(value, secrets);
    const encoded = JSON.stringify(clean) ?? '';
    if (encoded.includes(truncated)) remember(path);
    if (encoder.encode(encoded).length <= maximum) return clean;
    remember(path); return truncated;
  };
  const original = Array.isArray(report.findings) ? report.findings : [];
  const priorWarning = original.find(f => f.code === 'REPORT_TRUNCATED');
  const normal = original.filter(f => f.code !== 'REPORT_TRUNCATED');
  if (normal.length > 100) remember('findings');
  let visible = normal.slice(0, 100).map((finding, index) => {
    const safe = { code: text(finding.code, 120, 'findings'), severity: finding.severity === 'error' ? 'error' : 'warning',
      title: text(finding.title, 360, 'findings'), detail: text(finding.detail, 800, 'findings'), fix: text(finding.fix, 800, 'findings'),
      tool: text(finding.tool, 256, 'findings'), callIndex: Number.isInteger(finding.callIndex) ? finding.callIndex : 0 };
    for (const key of ['before', 'after']) if (finding[key] !== undefined) safe[key] = payload(finding[key], 'findings[' + index + '].' + key, 512);
    return safe;
  });
  const summary = {};
  for (const key of ['total', 'passed', 'attention', 'errors', 'warnings', 'timedCalls', 'durationMs']) {
    const value = report.summary[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) summary[key] = value;
    else { summary[key] = 0; remember('summary.' + key); }
  }
  const safe = { format: 'mcd-clinic-report', schemaVersion: 1,
    id: text(report.id, 256, 'id'), title: text(report.title, 512, 'title'), createdAt: text(report.createdAt, 128, 'createdAt'),
    source: text(report.source, 128, 'source'), sourceLabel: text(report.sourceLabel, 256, 'sourceLabel'),
    context: payload(report.context || {}, 'context'), summary, findings: [], calls: [] };
  const optional = [{ target: safe, key: 'context', path: 'context' }];
  safe.calls = report.calls.map((call, index) => {
    const path = 'calls[' + index + ']';
    const result = { tool: text(call.tool, 256, path + '.tool'), label: text(call.label || call.tool, 360, path + '.label'),
      status: ['passed', 'warning', 'error'].includes(call.status) ? call.status : 'warning', findings: [],
      findingCount: Number.isSafeInteger(call.findingCount) && call.findingCount >= 0 ? call.findingCount : (call.findings?.length || 0) };
    if (call.durationMs != null) {
      if (typeof call.durationMs === 'number' && Number.isFinite(call.durationMs) && call.durationMs >= 0) result.durationMs = call.durationMs;
      else remember(path + '.durationMs');
    }
    if (call.note != null) {
      result.note = text(call.note, 2_000, path + '.note');
      optional.push({ target: result, key: 'note', path: path + '.note' });
    }
    for (const key of ['input', 'output', 'error', 'meta']) if (call[key] !== undefined) {
      result[key] = payload(call[key], path + '.' + key);
      optional.push({ target: result, key, path: path + '.' + key });
    }
    return result;
  });
  const priorOmissions = Number.isSafeInteger(report.truncation?.omittedFindings) && report.truncation.omittedFindings > 0
    ? report.truncation.omittedFindings : 0;
  let warningIndex = 0;
  const assemble = () => {
    if (limited && visible.length === 100) visible = visible.slice(0, 99);
    const affectedPath = [...omittedFields].find(path => /^calls\[\d+\]/.test(path));
    const affectedIndex = affectedPath ? Number(affectedPath.match(/^calls\[(\d+)\]/)[1]) :
      normal[visible.length]?.callIndex ?? (omittedFields.has('findings') ? visible[0]?.callIndex : undefined) ?? priorWarning?.callIndex ?? 0;
    warningIndex = Number.isInteger(affectedIndex) && affectedIndex >= 0 && affectedIndex < safe.calls.length ? affectedIndex : 0;
    const marker = limited ? { code: 'REPORT_TRUNCATED', severity: 'warning', title: '报告内容已精简，检查范围受限',
      detail: '部分原始载荷、诊断详情或历史证据已省略；回放仅能重新检查保留的内容。',
      fix: '缩小记录范围重新取得完整报告；原始敏感数据只保留在可信本机。', tool: safe.calls[warningIndex]?.tool || '', callIndex: warningIndex } : null;
    safe.findings = [...visible, ...(marker ? [marker] : [])];
    safe.calls.forEach((call, index) => { call.findings = safe.findings.filter(f => f.callIndex === index); });
    if (marker) {
      safe.truncation = { truncated: true, omittedFindings: priorOmissions + normal.length - visible.length,
        omittedFields: [...omittedFields] };
    }
  };
  assemble();
  // Leave space below the 1 MB import limit for the surrounding HTTP envelope.
  const ranked = optional.map(field => ({ ...field, size: bytes(field.target[field.key]) })).sort((a, b) => b.size - a.size);
  let remainingBytes = bytes(safe);
  const markerBytes = bytes(truncated);
  for (const field of ranked) {
    if (remainingBytes <= 900_000) break;
    if (field.size <= markerBytes) continue;
    field.target[field.key] = truncated; remember(field.path);
    remainingBytes -= field.size - markerBytes;
  }
  assemble();
  if (limited && !priorWarning) {
    safe.summary.warnings++;
    if (safe.calls[warningIndex]) {
      safe.calls[warningIndex].findingCount++;
      if (safe.calls[warningIndex].status === 'passed') {
        safe.calls[warningIndex].status = 'warning'; safe.summary.passed = Math.max(0, safe.summary.passed - 1); safe.summary.attention++;
      }
    }
  }
  if (bytes(safe) > 1_000_000) throw new Error('报告摘要仍超过1MB，请缩小记录范围。');
  return safe;
}

export function stringifyReport(report) {
  const safe = redactReport(report);
  const pretty = JSON.stringify(safe, null, 2);
  return new TextEncoder().encode(pretty).length <= 999_000 ? pretty : JSON.stringify(safe);
}
