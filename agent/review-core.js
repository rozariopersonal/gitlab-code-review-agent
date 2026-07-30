/**
 * @file Shared utilities for the GitLab AI code review agent.
 * Used by both the CI pipeline script (ci-review.mjs) and webhook server (deprecated).
 * All functions are pure — no side effects, no I/O, no dependencies.
 */

/**
 * Replace literal newlines inside JSON strings with escaped newlines (\n).
 * Gemini sometimes returns real newlines within string values, which breaks JSON.parse.
 * Walks the raw character stream tracking string boundaries.
 * @param {string} raw - Raw JSON text from Gemini
 * @returns {string} Sanitized JSON text with escaped newlines in strings
 */
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

/**
 * Given a unified diff patch and a target line number in the new file,
 * find the corresponding old line number. Used to construct GitLab position
 * objects for inline comments on modified (not added) lines.
 *
 * Walks the hunk headers (@@ -old +new @@) and counts lines to determine
 * the old-line mapping. Returns {} for added lines (no old_line needed).
 * @param {string|undefined} patch - Unified diff patch text
 * @param {number} targetNewLine - Line number in the new file
 * @returns {{old_line?: number}} Object with old_line if the line exists in the old file
 */
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

/**
 * Extract all line numbers in the new file that appear in a unified diff patch.
 * Used to determine which positions are valid targets for inline comments.
 * @param {string} patch - Unified diff patch text
 * @returns {Set<number>} Set of new-file line numbers present in the diff
 */
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

/**
 * Format a unified diff patch with line number prefixes for the AI prompt.
 * Each line in the new file gets a "NNN>" prefix (e.g., " 42>+console.log()").
 * Removed lines show "    " (no prefix). Helps Gemini reference exact line numbers.
 * @param {string} patch - Unified diff patch text
 * @returns {string} Formatted diff with line number prefixes
 */
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

/**
 * Parse spec requirements from an MR description or .review-rules.md file.
 * Looks for a "## Spec" section and extracts checkbox items:
 *   - [ ] Requirement text
 *   - [x] Completed requirement text
 * @param {string} description - Markdown text (MR description or file content)
 * @returns {string[]} Array of requirement descriptions
 */
function parseSpec(description) {
  if (!description) return [];
  const m = description.match(/## Spec\s*\n([\s\S]*?)(?:\n## |$)/);
  if (!m) return [];
  const items = m[1].match(/-\s*\[.?\]\s*(.+)/g);
  if (!items) return [];
  return items.map(item => item.replace(/-\s*\[.?\]\s*/, '').trim());
}

/**
 * Build a markdown "Spec Requirements" section for the AI prompt.
 * Wraps spec items in a checklist format with [ ] markers.
 * @param {string[]} specs - Array of requirement descriptions
 * @returns {string} Formatted markdown section (empty string if no specs)
 */
function buildSpecContext(specs) {
  if (!specs || specs.length === 0) return '';
  const items = specs.map((s, i) => `${i + 1}. [ ] ${s}`).join('\n');
  return `## Spec Requirements\n\n${items}\n\n`;
}

/**
 * Build a markdown spec-compliance summary for the MR summary note.
 * Shows passed / failed checkboxes with reasons for failures.
 * @param {{text: string, satisfied: boolean, reason?: string}[]} specResults
 * @returns {string} Formatted markdown section (empty string if no results)
 */
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
