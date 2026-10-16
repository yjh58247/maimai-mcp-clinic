// One redaction boundary for browser responses, CLI output and downloadable reports.
const privateKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|.*token|.*secret|.*password|api[-_]?key|.*session[-_]?id|coupon(?:id|code)|orderid|payid|pay.*url|pickupcode|lockercode|lockerqrcode|.*(?:phone|mobile)|.*email|(?:customer|rider|receiver|recipient|consignee|contact).*|user(?:id|name|nickname)|.*address(?:id|detail)?|latitude|longitude|member(?:ship)?(?:id|code)|openid|unionid|access[-_]?key)$/i;
const hidden = '[已脱敏]';

export function redact(value, secrets = []) {
  let nodes = 0;
  const actualSecrets = secrets.filter(s => typeof s === 'string' && s.length > 3);
  function cleanString(text) {
    let result = text.slice(0, 120_000);
    for (const secret of actualSecrets) result = result.split(secret).join(hidden);
    result = result.replace(/\bBearer\s+(?!\$\{)[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${hidden}`)
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, hidden)
      .replace(/\b(?:sk|ghp|github_pat|sk-proj)[-_][A-Za-z0-9_-]{12,}\b/g, hidden)
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, hidden)
      .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, hidden)
      .replace(/((?:token|secret|password|api[_-]?key|couponCode|orderId|pickupCode)\s*[=:]\s*)[^\s&,;"']+/gi, `$1${hidden}`);
    // Tool responses often nest a JSON document inside a text content block.
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object') return JSON.stringify(walk(parsed, 0));
    } catch {}
    result = result.replace(/"([^"\n]+)"(\s*:\s*)(?:"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|null|true|false)/g, (match, key, separator) => privateKey.test(key) ? JSON.stringify(key) + separator + JSON.stringify(hidden) : match);
    return result;
  }
  function walk(item, depth) {
    if (++nodes > 40_000 || depth > 30) return '[内容过长，已截断]';
    if (typeof item === 'string') return cleanString(item);
    if (item == null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(v => walk(v, depth + 1));
    const result = Object.create(null);
    for (const [key, val] of Object.entries(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      result[key] = privateKey.test(key) ? hidden : walk(val, depth + 1);
    }
    return result;
  }
  return walk(value, 0);
}

export function markdownReport(report) {
  const safe = redact(report);
  const literal = value => String(value ?? '').replace(/[\r\n|]/g, ' ').replace(/`/g, '');
  const lines = [
    '# 麦麦 MCP 体检报告', '',
    `- 来源：${literal(safe.sourceLabel)}`,
    `- 生成时间：${literal(safe.createdAt)}`,
    `- 调用：${safe.summary.total}；通过：${safe.summary.passed}；需关注：${safe.summary.attention}`, '',
    '本报告只反映记录范围内的检查。离线案例与导入记录不代表当前门店实时结果。', '',
    '| 级别 | 诊断 | 建议 |', '| --- | --- | --- |'
  ];
  for (const item of safe.findings) lines.push(`| ${literal(item.severity)} | ${literal(item.title)} | ${literal(item.fix)} |`);
  if (!safe.findings.length) lines.push('| — | 在当前记录中未发现规则问题 | 请结合完整业务流程判断 |');
  lines.push('', '## 调用记录', '', '```json', JSON.stringify(safe.calls, null, 2), '```', '', '导出已按已知敏感字段和常见凭证格式脱敏；分享前仍应检查自由文本。', '');
  return lines.join('\n');
}
