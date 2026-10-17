import { isRecord } from './context.mjs';

// Used by the browser, server and portable CLI before analyzing untrusted JSON.
export function recordValidationError(raw, { reportOnly = false } = {}) {
  if (!isRecord(raw)) return '记录必须是 JSON 对象。';
  if (reportOnly || raw.format !== undefined) {
    if (raw.format !== 'mcd-clinic-report' || raw.schemaVersion !== 1)
      return '请导入由体检站导出的 v1 JSON 报告；当前不支持此格式或版本。';
  }
  if (!Array.isArray(raw.calls) || !raw.calls.length || raw.calls.length > 100)
    return '需要1至100条调用记录。';
  const index = raw.calls.findIndex(call => !isRecord(call) || typeof call.tool !== 'string' || !call.tool.trim());
  if (index >= 0) return 'calls[' + index + '] 需要包含非空字符串 tool。';
  const timing = raw.calls.findIndex(call => call.durationMs != null && (typeof call.durationMs !== 'number' || !Number.isFinite(call.durationMs) || call.durationMs < 0));
  if (timing >= 0) return 'calls[' + timing + '].durationMs 应为大于等于0的数字。';
  return null;
}
