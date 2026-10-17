export function inspectionRun({ tool, input, output, displayedTotal, report, callIndex = null }) {
  const previous = Array.isArray(report?.calls) ? report.calls.slice(0, Number.isInteger(callIndex) ? callIndex : undefined) : [];
  const reduced = previous.length > 99 || report?.truncation?.truncated === true;
  return { title: '手动调用检查', source: 'manual', context: report?.context || {},
    ...(reduced ? { truncation: { truncated: true } } : {}), calls: [...previous.slice(-99),
    { tool, input, ...(output !== undefined ? { output } : {}), ...(displayedTotal != null ? { meta: { displayedTotal } } : {}) }] };
}
