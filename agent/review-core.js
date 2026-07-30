function fixJSONNewlines(raw) {
  let out = '', inStr = false, esc = false;
  for (const ch of raw) {
    if (esc) { esc = false; out += ch; continue; }
    if (ch === '\\') { esc = true; out += ch; continue; }
    if (ch === '"' && !esc) { inStr = !inStr; out += ch; continue; }
    if (ch === '\n' && inStr) { out += '\\n'; continue; }
    out += ch;
  }
  return out;
}

function getLinePosition(patch, targetNewLine) {
  if (!patch) return {};
  const lines = patch.split('\n');
  let oldLine = 0, newLine = 0;
  for (const line of lines) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { oldLine = parseInt(m[1]) - 1; newLine = parseInt(m[2]) - 1; continue; }
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+')) { newLine++; if (newLine === targetNewLine) return {}; }
    else if (line.startsWith('-')) { oldLine++; }
    else { oldLine++; newLine++; if (newLine === targetNewLine) return { old_line: oldLine }; }
  }
  if (targetNewLine > newLine) return { old_line: oldLine + (targetNewLine - newLine) };
  return {};
}

function getDiffLineNumbers(patch) {
  const lines = patch.split('\n');
  const nums = new Set();
  let newLine = 0;
  for (const line of lines) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { newLine = parseInt(m[1]); continue; }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('+') || line.startsWith(' ')) { nums.add(newLine); newLine++; }
  }
  return nums;
}

function formatDiffWithLineNumbers(patch) {
  const lines = patch.split('\n');
  const out = [];
  let newLine = 0;
  for (const line of lines) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { newLine = parseInt(m[1]); out.push(line); continue; }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) { out.push(line); continue; }
    if (line.startsWith('+')) { out.push(`${String(newLine).padStart(3)}>${line}`); newLine++; }
    else if (line.startsWith(' ')) { out.push(`${String(newLine).padStart(3)}>${line}`); newLine++; }
    else if (line.startsWith('-')) { out.push(`    ${line}`); }
    else { out.push(line); }
  }
  return out.join('\n');
}

function parseSpec(description) {
  if (!description) return [];
  const m = description.match(/## Spec\s*\n([\s\S]*?)(?:\n## |$)/);
  if (!m) return [];
  const items = m[1].match(/-\s*\[.?\]\s*(.+)/g);
  if (!items) return [];
  return items.map(item => item.replace(/-\s*\[.?\]\s*/, '').trim());
}

function buildSpecContext(specs) {
  if (!specs || specs.length === 0) return '';
  const items = specs.map((s, i) => `${i + 1}. [ ] ${s}`).join('\n');
  return `## Spec Requirements\n\n${items}\n\n`;
}

function buildSpecExtra(specResults) {
  if (!specResults || specResults.length === 0) return '';
  const passed = specResults.filter(s => s.satisfied);
  const failed = specResults.filter(s => !s.satisfied);
  const lines = passed.map(s => `- [x] ${s.text}`);
  const flines = failed.map(s => `- [ ] ${s.text}${s.reason ? ` — ${s.reason}` : ''}`);
  return `\n\n#### Spec Compliance\n${lines.join('\n')}\n${flines.join('\n')}`;
}

module.exports = {
  fixJSONNewlines,
  getLinePosition,
  getDiffLineNumbers,
  formatDiffWithLineNumbers,
  parseSpec,
  buildSpecContext,
  buildSpecExtra,
};
