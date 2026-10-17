export function inspectionRun({ tool, input, output, displayedTotal, report, callIndex = null }) {
  const previous = Array.isArray(report?.calls) ? report.calls.slice(0, Number.isInteger(callIndex) ? callIndex : undefined) : [];
  return { title: '手动调用检查', source: 'manual', context: report?.context || {}, calls: [...previous,
    { tool, input, ...(output !== undefined ? { output } : {}), ...(displayedTotal != null ? { meta: { displayedTotal } } : {}) }] };
}
